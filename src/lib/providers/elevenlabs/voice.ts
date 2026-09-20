import { config } from "@/lib/config";
import { ProviderError } from "@/lib/providers/types";
import { secrets } from "@/lib/settings";
import { V3_STABILITY_STEPS } from "@/lib/types";
import type {
  TaskHandle,
  TaskResult,
  VoiceOption,
  VoiceProvider,
  VoiceQuery,
  VoiceRequest,
} from "@/lib/providers/types";

/**
 * ElevenLabs, called directly rather than through an aggregator.
 *
 * This exists because the same models reached via KIE return `500 internal
 * error` for every request — including KIE's own documented example payload —
 * while every other model on that account works. Going direct removes the
 * middleman for the one stage that needed it and changes nothing else: images,
 * clips and lip sync still run wherever they are configured.
 *
 * Unlike every other provider here this API is **synchronous** — it returns
 * audio bytes from the POST rather than a task id to poll. The submit/poll
 * shape is kept anyway so the job runner, progress reporting and retry logic
 * work unchanged; `submit` does the work and `poll` hands back the result that
 * is already in hand.
 */

const API_BASE = "https://api.elevenlabs.io/v1";
const MAX_TEXT_CHARS = 5000;

/** Results waiting to be collected by the first poll, keyed by handle id. */
const completed = new Map<string, TaskResult>();

function apiKey(): string {
  const key = secrets().elevenLabsApiKey;
  if (!key) {
    throw new ProviderError(
      "No ElevenLabs API key configured. Add one on the Settings page, or set ELEVENLABS_API_KEY in .env.local.",
      "elevenlabs",
    );
  }
  return key;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";

  async submit(request: VoiceRequest): Promise<TaskHandle> {
    const { voice } = request;
    const taskId = `el_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const model = config.elevenLabs.model;
    const isV3 = /^eleven_v3/.test(model);

    const settings: Record<string, unknown> = {
      // v3 exposes stability as three discrete modes rather than a continuum.
      stability: isV3 ? snapToV3Stability(voice.stability) : clamp(voice.stability, 0, 1),
      similarity_boost: clamp(voice.similarityBoost, 0, 1),
      style: clamp(voice.style, 0, 1),
      // Reinforces the reference timbre, which is the point of a locked voice.
      use_speaker_boost: true,
    };
    // v3 rejects `speed`; it takes pacing from the text and the delivery tag.
    if (!isV3) settings.speed = clamp(voice.speed, 0.7, 1.2);

    const body: Record<string, unknown> = {
      text: truncate(isV3 ? withDelivery(request.text, request.delivery) : request.text, MAX_TEXT_CHARS),
      model_id: model,
      voice_settings: settings,
    };
    // Adjacent script text as prosody context, so delivery does not reset at
    // every scene boundary.
    //
    // v3 rejects both outright: "Providing previous_text or next_text is not
    // yet supported with the 'eleven_v3' model", HTTP 400. Since v3 is the
    // default model, sending them failed *every* voice render — the stitching
    // that was meant to make narration continuous instead made it impossible.
    // v3 gets its continuity from the delivery tag instead.
    if (!isV3) {
      if (request.previousText) body.previous_text = truncate(request.previousText, MAX_TEXT_CHARS);
      if (request.nextText) body.next_text = truncate(request.nextText, MAX_TEXT_CHARS);
    }
    if (voice.languageCode) body.language_code = voice.languageCode;

    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/text-to-speech/${encodeURIComponent(voice.voiceId)}` +
          `?output_format=${encodeURIComponent(config.elevenLabs.outputFormat)}`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (cause) {
      throw new ProviderError("Network error calling ElevenLabs", "elevenlabs", undefined, cause);
    }

    if (!response.ok) {
      // Errors arrive as JSON even though success is binary audio.
      throw new ProviderError(
        explain(response.status, await response.text()),
        "elevenlabs",
        response.status,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new ProviderError("ElevenLabs returned an empty audio body", "elevenlabs");
    }

    // The storage layer decodes data URLs the same way it downloads a remote
    // one, so nothing downstream needs a special case for this provider.
    const mime = response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
    completed.set(taskId, {
      status: "succeeded",
      progress: 100,
      urls: [`data:${mime};base64,${bytes.toString("base64")}`],
      raw: { provider: "elevenlabs", bytes: bytes.length, mime },
    });

    return { taskId, provider: this.name };
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    const result = completed.get(handle.taskId);
    if (!result) {
      return {
        status: "failed",
        progress: 0,
        urls: [],
        error: "Unknown ElevenLabs task (its result was already collected)",
      };
    }
    completed.delete(handle.taskId);
    return result;
  }

  /**
   * Voices the creator form can offer.
   *
   * A shortlist, not a catalogue. The shared library holds about fifteen
   * thousand voices, and handing someone fifteen thousand options is the same
   * as handing them none — the useful thing is a small set that is right for
   * this product, with the rest reachable by searching.
   *
   * Three tiers, in this order: voices this account created or added, then the
   * curated shortlist, then the stock voices every ElevenLabs account ships
   * with. That ordering is the point of the feature. The stock voices are the
   * ones that sound synthetic — the complaint this work exists to answer — and
   * they used to be the whole list and the top of it. They are kept, because a
   * catalogue that hides options the account can actually use is worse than a
   * long one, but nothing else should ever sort below them.
   *
   * The library is only offered on a paid plan. A free plan refuses library
   * voices with `402 paid_plan_required`, and — critically — refuses at *render*
   * time rather than at selection time, so a voice chosen on Monday fails on
   * Wednesday halfway through a paid job. Asking the account what it is allowed
   * to do keeps that decision at the point of choice.
   */
  async listVoices(query: VoiceQuery = {}): Promise<VoiceOption[]> {
    const [account, library] = await Promise.all([
      this.accountVoices(),
      this.libraryVoices(query),
    ]);

    // An account voice and a library voice can be the same voice — adding one
    // from the library copies it in. Prefer the library's copy here, since it
    // carries the descriptors the picker displays.
    const seen = new Set(library.map((v) => v.id));
    const own = account.filter((v) => v.source === "account" && !seen.has(v.id));
    const stock = account.filter((v) => v.source === "stock" && !seen.has(v.id));

    const merged = [...own, ...library, ...stock];
    return merged.length > 0 ? merged : PREMADE_VOICES;
  }

  private async accountVoices(): Promise<VoiceOption[]> {
    try {
      const response = await fetch(`${API_BASE}/voices`, {
        headers: { "xi-api-key": apiKey() },
      });
      if (!response.ok) return PREMADE_VOICES;
      const body = (await response.json()) as {
        voices?: Array<{
          voice_id: string;
          name: string;
          category?: string;
          preview_url?: string;
          labels?: Record<string, string>;
        }>;
      };
      return (body.voices ?? []).map((v) => ({
        id: v.voice_id,
        label: v.name,
        // `premade` is the set every account is issued with; anything else was
        // cloned or added deliberately, and belongs above the shortlist.
        source: (v.category === "premade" ? "stock" : "account") as "stock" | "account",
        previewUrl: v.preview_url,
        gender: v.labels?.gender,
        age: v.labels?.age,
        accent: v.labels?.accent,
        descriptive: v.labels?.descriptive ?? v.labels?.description,
        useCase: v.labels?.use_case,
      }));
    } catch {
      return PREMADE_VOICES;
    }
  }

  /**
   * A shortlist drawn from the shared library.
   *
   * With no search typed this fetches the two use-cases that match what this
   * product makes — a person talking to a phone camera — and keeps the studio-
   * cloned ones. Searching widens to the whole library, because at that point
   * the operator has said what they want and a shortlist would be in the way.
   *
   * The length of the list is a consequence of the quality bar rather than a
   * number chosen in advance, which is the right way round: a fixed count
   * either pads a short list with worse voices or truncates a good one.
   *
   * Four filters do the reducing, each established against the live API:
   *
   * `sort=trending` ranks by how much the library actually uses a voice. The
   * endpoint's default ordering returns the newest uploads — voices with no
   * usage and no track record, the worst possible thing at the top of a picker.
   *
   * `language=en` cuts the catalogue from 15,648 to 9,573. Unfiltered, more
   * than half of a trending page is Hindi, Spanish or German: fine voices,
   * useless for an English script.
   *
   * Excluding `characters_animation` is the difference between realistic and
   * not. Half of the library's own featured selection is that category —
   * cartoon and game-character reads, deliberately theatrical. They are the
   * opposite of a real person talking.
   *
   * Keeping only `professional` is the quality bar itself; see PREMIUM_CATEGORY.
   */
  private async libraryVoices(query: VoiceQuery): Promise<VoiceOption[]> {
    if (!(await this.canUseLibrary())) return [];

    const searching = Boolean(query.search || query.useCase);
    const useCases = query.useCase ? [query.useCase] : searching ? [undefined] : CURATED_USE_CASES;
    const wanted = searching ? SEARCH_RESULT_COUNT : CURATED_COUNT;

    const pages = await Promise.all(
      useCases.map((useCase) => this.libraryPage(query, useCase)),
    );

    // Pool both use-cases and rank across them, so the list is ordered by how
    // good the voices are rather than by which query they happened to arrive on.
    const pool: VoiceOption[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      for (const voice of page) {
        if (!seen.has(voice.id)) {
          seen.add(voice.id);
          pool.push(voice);
        }
      }
    }

    const premium = pool.filter((v) => v.premium);
    if (premium.length >= MIN_PREMIUM) return premium.slice(0, wanted);

    // Too few to stand on their own: keep them first and fill from the rest.
    return [...premium, ...pool.filter((v) => !v.premium)].slice(0, wanted);
  }

  private async libraryPage(
    query: VoiceQuery,
    useCase: string | undefined,
  ): Promise<VoiceOption[]> {
    const params = new URLSearchParams({
      // A full page every time. The quality filter runs on the response, so a
      // small page would be filtered down to almost nothing — the pool has to
      // be large for the bar to be selective rather than merely restrictive.
      page_size: String(CANDIDATE_PAGE_SIZE),
      sort: "trending",
      language: "en",
    });
    if (useCase) params.set("use_cases", useCase);
    if (query.search) params.set("search", query.search);
    if (query.gender) params.set("gender", query.gender);
    if (query.age) params.set("age", query.age);
    if (query.accent) params.set("accent", query.accent);

    try {
      const data = (await json(`${API_BASE}/shared-voices?${params}`, {
        "xi-api-key": apiKey(),
      })) as {
        voices?: Array<{
          voice_id: string;
          name: string;
          preview_url?: string;
          gender?: string;
          age?: string;
          accent?: string;
          descriptive?: string;
          use_case?: string;
          category?: string;
        }>;
      };
      return (data.voices ?? [])
        .filter((v) => v.use_case !== "characters_animation")
        .map((v) => ({
          id: v.voice_id,
          label: v.name,
          source: "library" as const,
          previewUrl: v.preview_url,
          gender: v.gender,
          age: v.age,
          accent: v.accent,
          descriptive: v.descriptive,
          useCase: v.use_case,
          premium: v.category === PREMIUM_CATEGORY,
        }));
    } catch {
      // The library is an enhancement; losing it should still leave a usable
      // picker rather than an empty one.
      return [];
    }
  }

  /**
   * Whether this plan may use library voices, cached because it is asked on
   * every render of the creator form and changes at most once per billing
   * change.
   */
  private async canUseLibrary(): Promise<boolean> {
    const now = Date.now();
    if (tierCache && now - tierCache.at < TIER_TTL_MS) return tierCache.paid;
    try {
      const data = (await json(`${API_BASE}/user/subscription`, {
        "xi-api-key": apiKey(),
      })) as { tier?: string };
      const paid = Boolean(data.tier) && data.tier !== "free";
      tierCache = { paid, at: now };
      return paid;
    } catch {
      // Unknown plan: assume the restricted one. Offering a voice that cannot
      // be used is worse than offering fewer.
      return false;
    }
  }
}

/**
 * What the shortlist is drawn from when nothing has been searched for.
 *
 * These two are people talking to camera, which is what this product makes.
 * `narrative_story` is the library's largest category and is deliberately left
 * out: those are audiobook reads — excellent, and audibly performed rather
 * than spoken, which is the wrong register for a social post.
 */
const CURATED_USE_CASES = ["social_media", "conversational"];

/**
 * The quality bar, and the reason the shortlist is short.
 *
 * `professional` is the provider's studio-cloned tier: built from hours of
 * recorded audio rather than a short sample, and the tier that stops sounding
 * like text-to-speech. `high_quality` is a clone from a brief sample and
 * `generated` is fully synthetic — the latter being exactly the thing this
 * product is trying not to sound like.
 *
 * It has to be applied to the response rather than the request. `category` is
 * a documented query parameter and the API accepts it, then ignores it: the
 * reply comes back with the full unfiltered count and rows of every other
 * category in it.
 *
 * How much this matters depends entirely on asking the right question. In a
 * plain trending page, one voice in a hundred is `professional`. Filtered to
 * English and to the two use-cases above, it is 65 in 100 for social media and
 * 46 in 100 for conversational — so the premium tier is not rare, it is just
 * buried under everything else.
 */
const PREMIUM_CATEGORY = "professional";

/** The endpoint's largest page, so the filter has a full pool to select from. */
const CANDIDATE_PAGE_SIZE = 100;

/**
 * Below this many premium voices the list is topped up from the next tier
 * down. A short list of the best is the goal; a nearly empty one is a fault,
 * and the account or the catalogue could change under us.
 */
const MIN_PREMIUM = 12;

/** Voices shown with no search typed, and once one is. */
const CURATED_COUNT = 40;
const SEARCH_RESULT_COUNT = 30;
const TIER_TTL_MS = 5 * 60_000;
let tierCache: { paid: boolean; at: number } | null = null;

async function json(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

/**
 * ElevenLabs premade voices, confirmed present on a live free-tier account.
 *
 * The fallback when the API cannot be reached, and the whole catalogue on a
 * free plan: library entries are refused there with `402 paid_plan_required`.
 */
const PREMADE_VOICES: VoiceOption[] = [
  { id: "cgSgspJ2msm6clMCkdW9", label: "Jessica — playful, bright, warm (F)", source: "stock" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — mature, reassuring, confident (F)", source: "stock" },
  { id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura — enthusiast, quirky (F)", source: "stock" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice — clear, engaging educator (F)", source: "stock" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda — knowledgable, professional (F)", source: "stock" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam — energetic, social media creator (M)", source: "stock" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George — warm, captivating storyteller (M)", source: "stock" },
  { id: "cjVigY5qzO86Huf0OWal", label: "Eric — smooth, trustworthy (M)", source: "stock" },
  { id: "bIHbv24MWmeRgasZH58o", label: "Will — relaxed optimist (M)", source: "stock" },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie — deep, confident, energetic (M)", source: "stock" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", label: "Roger — laid-back, casual, resonant (M)", source: "stock" },
  { id: "SAz9YHcvj6GT2YYXdXww", label: "River — relaxed, neutral, informative (N)", source: "stock" },
];

/** Turn ElevenLabs' error envelope into something that names the actual fix. */
function explain(status: number, raw: string): string {
  let detail: { status?: string; message?: string } | undefined;
  try {
    detail = (JSON.parse(raw) as { detail?: typeof detail }).detail;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  const message = detail?.message ?? raw.slice(0, 300);

  if (status === 402 && /library voice/i.test(message)) {
    return `${message} Pick a premade voice instead — the creator form lists the ones this plan can use.`;
  }
  if (status === 401) {
    return `${message} Check the ElevenLabs key on the Settings page.`;
  }
  return `ElevenLabs error ${status}: ${message}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function snapToV3Stability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return V3_STABILITY_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

/**
 * Prefix a v3 delivery tag, e.g. `[warmly] Tokyo after midnight…`.
 *
 * v3 interprets these rather than reading them out — confirmed by transcribing
 * a tagged render and checking the tag does not appear in the words. They are
 * the cheapest available lever on naturalness, which matters because creating a
 * custom voice through the API needs a paid plan.
 *
 * Skipped when the caller's text already opens with a tag, so a hand-written
 * line is never second-guessed.
 */
function withDelivery(text: string, delivery?: string): string {
  const trimmed = text.trim();
  if (!delivery || /^\s*\[/.test(trimmed)) return trimmed;
  const tag = delivery.trim().replace(/^\[|\]$/g, "");
  return tag ? `[${tag}] ${trimmed}` : trimmed;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
