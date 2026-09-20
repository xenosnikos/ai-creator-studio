import fs from "node:fs";
import path from "node:path";

import { config } from "@/lib/config";

/**
 * Runtime settings.
 *
 * API keys and provider selection can come from two places: environment
 * variables (good for servers and CI) or the in-app Settings page (good for
 * someone who just downloaded this and wants to paste a key). Stored settings
 * win, so the UI can always override a stale env var.
 *
 * Secrets are written to DATA_DIR/settings.json with 0600 permissions and are
 * never returned to the browser in plaintext — the API returns a masked hint
 * plus a boolean.
 */

export interface StoredSettings {
  anthropicApiKey?: string;
  kieApiKey?: string;
  elevenLabsApiKey?: string;
  anthropicModel?: string;
  imageProvider?: string;
  videoProvider?: string;
  voiceProvider?: string;
  lipSyncProvider?: string;
  llmProvider?: string;
}

const SETTINGS_FILE = () => path.join(config.dataDir, "settings.json");

let cache: StoredSettings | null = null;
/** Which version of the file `cache` was built from. `""` means "no file". */
let cacheStamp: string | null = null;

/**
 * Identity of settings.json as it is on disk right now.
 *
 * The cache is keyed to this rather than merely being populated once, because
 * "populated once" is wrong in the shape Next.js actually runs this app.
 *
 * A server component and a route handler are compiled into *separate* module
 * graphs, so `src/lib/settings.ts` is instantiated twice and each copy gets its
 * own `cache`. Saving a key goes through the route handler, which updated its
 * own copy and left the Settings page's copy holding whatever it read first —
 * usually nothing. The key was written to disk correctly and the POST response
 * showed it saved, then reloading the page showed "not configured" until the
 * server was restarted, which reads as "my keys don't save". Worse than the
 * cosmetics: a stage reading its key through a stale copy fails with "no API
 * key configured" for a key that is sitting in the file.
 *
 * A stat is a syscall against a page already in the OS cache — far cheaper than
 * re-parsing the JSON, and cheap enough to do on every read. Size is included
 * because filesystems with coarse timestamp granularity can otherwise report
 * two nearby writes as the same instant.
 */
function stamp(): string {
  try {
    const stats = fs.statSync(SETTINGS_FILE());
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "";
  }
}

function read(): StoredSettings {
  const current = stamp();
  if (cache && cacheStamp === current) return cache;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), "utf8");
    cache = JSON.parse(raw) as StoredSettings;
  } catch {
    // Missing is normal on a fresh install; unparseable means someone edited
    // the file by hand. Either way the environment still supplies keys, and
    // stamping the failure stops us re-reading a broken file on every call.
    cache = {};
  }
  cacheStamp = current;
  return cache;
}

export function saveSettings(patch: StoredSettings): void {
  const current = read();
  const next: StoredSettings = { ...current };

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof StoredSettings, string | undefined]
  >) {
    if (value === undefined) continue;
    if (value === "") {
      // Empty string means "clear this and fall back to the environment".
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  // Tighten permissions even if the file already existed with a looser mode.
  try {
    fs.chmodSync(SETTINGS_FILE(), 0o600);
  } catch {
    // Non-POSIX filesystems (e.g. some Windows setups) may not support chmod.
  }
  cache = next;
  cacheStamp = stamp();
}

/**
 * Reject values that are obviously the placeholder text from `.env.example`
 * rather than a real key. Without this, `cp .env.example .env.local` leaves
 * `ANTHROPIC_API_KEY=sk-ant-...` in place and the app reports a key as
 * configured, then fails confusingly on the first real call.
 */
function realKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("...") || trimmed.startsWith("<") || trimmed.length < 8) {
    return undefined;
  }
  return trimmed;
}

/** Effective secrets: stored settings first, then environment. */
export function secrets(): {
  anthropicApiKey?: string;
  kieApiKey?: string;
  elevenLabsApiKey?: string;
} {
  const stored = read();
  return {
    anthropicApiKey: realKey(stored.anthropicApiKey) ?? realKey(config.anthropic.apiKey),
    kieApiKey: realKey(stored.kieApiKey) ?? realKey(config.kie.apiKey),
    elevenLabsApiKey: realKey(stored.elevenLabsApiKey) ?? realKey(config.elevenLabs.apiKey),
  };
}

export function anthropicModel(): string {
  return read().anthropicModel ?? config.anthropic.model;
}

/**
 * Effective provider selection: stored setting, then an explicit environment
 * variable, then a credential-aware default.
 *
 * That last step matters for first-run experience. Defaulting to a live provider
 * when no key exists produces an app that *looks* configured and then fails on
 * the first generation. Falling back to `mock` instead means a fresh clone works
 * immediately, and the Settings page promotes each stage the moment its key
 * arrives.
 */
export function providers(): {
  image: string;
  video: string;
  voice: string;
  lipSync: string;
  llm: string;
} {
  const stored = read();
  const available = secrets();

  const pick = (
    storedValue: string | undefined,
    envName: string,
    liveProvider: string,
    hasCredential: boolean,
  ): string => {
    if (storedValue) return storedValue;
    // An explicit env var is an operator decision — honour it even if the key is
    // missing, so the resulting error names the real problem.
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
    return hasCredential ? liveProvider : "mock";
  };

  const hasKie = Boolean(available.kieApiKey);
  const hasAnthropic = Boolean(available.anthropicApiKey);
  const hasElevenLabs = Boolean(available.elevenLabsApiKey);

  return {
    image: pick(stored.imageProvider, "IMAGE_PROVIDER", "kie", hasKie),
    video: pick(stored.videoProvider, "VIDEO_PROVIDER", "kie", hasKie),
    /**
     * Voice never auto-selects KIE.
     *
     * KIE's ElevenLabs passthrough returns "please try again later" for every
     * request — including KIE's own documented example payload. Selecting it
     * just because a KIE key happens to be present sends every render down a
     * route that cannot work, and the failure looks like a transient outage
     * rather than a dead path.
     *
     * So: ElevenLabs when its key is present, otherwise placeholder audio,
     * which at least completes the render and says plainly what is missing.
     * `kie` remains selectable by hand for anyone whose account works.
     */
    voice: voiceRoute(pick(stored.voiceProvider, "VOICE_PROVIDER", "elevenlabs", hasElevenLabs)),
    lipSync: pick(stored.lipSyncProvider, "LIPSYNC_PROVIDER", "kie", hasKie),
    llm: pick(stored.llmProvider, "LLM_PROVIDER", "anthropic", hasAnthropic),
  };
}

/**
 * Correct a stored `kie` voice selection.
 *
 * The default has never chosen KIE for voice, but a value saved before that
 * rule existed — or picked from a dropdown that used to offer it — is honoured
 * forever afterwards, and every voice render then fails with KIE's "internal
 * error, please try again later". That reads as a transient outage, so it gets
 * retried rather than diagnosed.
 *
 * A setting that cannot work is not a preference worth preserving, so it is
 * redirected when there is a working route to redirect to. An operator whose
 * KIE account does work can still force it with VOICE_PROVIDER=kie, which
 * bypasses this because it is a live, deliberate instruction rather than a
 * stale saved one.
 */
function voiceRoute(selected: string): string {
  if (selected !== "kie") return selected;
  if (process.env.VOICE_PROVIDER?.trim() === "kie") return "kie";
  return realKey(read().elevenLabsApiKey) ?? realKey(config.elevenLabs.apiKey)
    ? "elevenlabs"
    : "mock";
}

/** Where a given value is coming from — shown in the UI so it is never a mystery. */
export function sourceOf(key: keyof StoredSettings): "settings" | "env" | "default" {
  const isKeyField =
    key === "anthropicApiKey" || key === "kieApiKey" || key === "elevenLabsApiKey";
  const stored = read()[key];
  if (stored !== undefined && (!isKeyField || realKey(stored))) return "settings";
  const envKey: Record<keyof StoredSettings, string> = {
    anthropicApiKey: "ANTHROPIC_API_KEY",
    kieApiKey: "KIE_API_KEY",
    elevenLabsApiKey: "ELEVENLABS_API_KEY",
    anthropicModel: "ANTHROPIC_MODEL",
    imageProvider: "IMAGE_PROVIDER",
    videoProvider: "VIDEO_PROVIDER",
    voiceProvider: "VOICE_PROVIDER",
    lipSyncProvider: "LIPSYNC_PROVIDER",
    llmProvider: "LLM_PROVIDER",
  };
  const fromEnv = process.env[envKey[key]];
  if (!fromEnv) return "default";
  return isKeyField && !realKey(fromEnv) ? "default" : "env";
}

/** `sk-ant-api03-abcd…WXYZ` — enough to recognise a key, not enough to use it. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 2)}${"•".repeat(6)}`;
  return `${value.slice(0, 8)}${"•".repeat(6)}${value.slice(-4)}`;
}

/** Drop the in-memory cache — used after a save so the next read is fresh. */
export function invalidateSettingsCache(): void {
  cache = null;
  cacheStamp = null;
}
