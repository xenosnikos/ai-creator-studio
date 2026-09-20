import { ProviderError } from "@/lib/providers/types";
import { secrets } from "@/lib/settings";
import type { MusicMood } from "@/lib/types";

/**
 * Background music for the finished cut.
 *
 * Synchronous like the voice endpoint — the POST returns audio bytes rather
 * than a task id — so this is a plain function rather than a submit/poll
 * provider. It runs once per final cut, not once per scene, and nothing
 * downstream needs to poll it.
 *
 * Scored against the whole video rather than per shot on purpose: a bed that
 * restarts at every cut announces the edit, which is the opposite of what
 * music is here to do.
 */

const API_BASE = "https://api.elevenlabs.io/v1";

/**
 * The music model's accepted range, in milliseconds.
 *
 * Videos here run from five to ninety seconds, comfortably inside it. The
 * clamp exists so a request is never *rejected* for length — if the video sits
 * outside the range the bed is trimmed or looped to fit instead, which is a
 * silent correction rather than a failed render.
 */
const MIN_MS = 3_000;
const MAX_MS = 300_000;

/**
 * What each mood asks for.
 *
 * Every one of these ends by ruling out vocals. A sung line under a spoken one
 * is unlistenable, and the model will happily add one when the prompt does not
 * say otherwise.
 */
const PROMPTS: Record<Exclude<MusicMood, "off">, string> = {
  calm:
    "Soft, unobtrusive ambient background bed for a talking-head social video. " +
    "Gentle sustained pads, slow movement, no percussion, no vocals. " +
    "Sits far behind a speaking voice and never draws attention.",
  upbeat:
    "Light, modern, positive background bed for a short social video. " +
    "Soft electronic pulse, steady low-key rhythm, quietly propulsive but " +
    "restrained in the mix, no vocals, no drops, no build to a climax.",
  warm:
    "Warm, intimate background bed for a personal talking-head video. " +
    "Soft acoustic texture, mellow low-mid tones, unhurried, no percussion, " +
    "no vocals. Comforting rather than sentimental.",
  cinematic:
    "Restrained cinematic underscore for a short-form video. " +
    "Sparse sustained strings and low piano, slow harmonic movement, " +
    "a sense of scale without volume, no percussion, no vocals, no swell.",
};

export interface ComposedMusic {
  bytes: Buffer;
  mime: string;
  prompt: string;
}

/**
 * Compose a bed of roughly `seconds` length.
 *
 * Returns `null` when no key is configured, because music is an enhancement:
 * a project that asked for it and cannot have it should still deliver its
 * video rather than fail the final cut.
 */
export async function composeMusic(
  mood: MusicMood,
  seconds: number,
): Promise<ComposedMusic | null> {
  if (mood === "off") return null;
  const key = secrets().elevenLabsApiKey;
  if (!key) return null;

  const prompt = PROMPTS[mood];
  const lengthMs = Math.min(MAX_MS, Math.max(MIN_MS, Math.round(seconds * 1000)));

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/music`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, music_length_ms: lengthMs }),
    });
  } catch (cause) {
    throw new ProviderError("Network error calling ElevenLabs music", "elevenlabs", undefined, cause);
  }

  if (!response.ok) {
    const raw = await response.text();
    let message = raw.slice(0, 300);
    try {
      message = (JSON.parse(raw) as { detail?: { message?: string } }).detail?.message ?? message;
    } catch {
      // Not JSON; the raw text is the best available description.
    }
    throw new ProviderError(`ElevenLabs music error ${response.status}: ${message}`, "elevenlabs", response.status);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new ProviderError("ElevenLabs returned an empty music body", "elevenlabs");
  }

  return {
    bytes,
    mime: response.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
    prompt,
  };
}
