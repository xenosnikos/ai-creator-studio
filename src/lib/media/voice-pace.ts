import fs from "node:fs";
import path from "node:path";

import { config } from "@/lib/config";
import { audioDuration } from "@/lib/media/duration";
import { voiceProvider } from "@/lib/providers/registry";
import type { VoiceConfig } from "@/lib/types";

/**
 * How fast does this particular voice actually talk?
 *
 * The storyboard writer is told how long a scene's line may run to, and that
 * budget is a speaking rate times the length of a shot. It used to assume one
 * rate for every voice, and the rate was wrong for most of them.
 *
 * Measured on a real render: a library voice described as "soft, conversational"
 * took 17.9 seconds over a line the app had budgeted at 13.8. The recording then
 * outlasted the shot, the lip-sync model stretched the picture to cover it, and
 * the mouth slid out of step across the whole clip. The visible symptom was bad
 * lip sync; the cause was arithmetic.
 *
 * The rate is in **characters** per second, not words, and that choice is what
 * makes this work. Across the same voice, words per second varied by 62% between
 * a plain line and a scripted one — 3.52 against 2.17 — because a word is not a
 * unit of time and "immigration" takes three times as long to say as "the".
 * Characters per second varied by 26% over the same pair, and once the
 * calibration line is written like real script copy the residual error drops to
 * a few percent.
 *
 * Voices differ from each other far more than they differ from themselves, so
 * one measurement per voice is enough and it is cached. The cost is a few
 * seconds of synthesis, once, against a quota measured in tens of thousands of
 * characters.
 */

/**
 * Fallback when a voice has never been measured and cannot be.
 *
 * Close to what real voices measure, and deliberately not the rate implied by
 * the old words-per-second figure — that worked out near 20 characters a second,
 * which no voice tested here comes close to.
 */
export const DEFAULT_CHARS_PER_SECOND = 14;

/**
 * The calibration line, and it has to read like the thing being measured.
 *
 * A first attempt used plain, short-worded prose and measured this voice at 17.7
 * characters a second, where the same voice read actual script copy at 14.0 —
 * which would have made every budget 25% too generous, the exact failure this
 * is meant to remove. This line is matched to what the storyboard writer
 * produces: around six and a half characters per word, one aside set off by a
 * dash, and a couple of commas, because pauses are part of the pace.
 *
 * No delivery tag. Tags were tested and change the rate by under 1%, so
 * including one would only add a variable without adding accuracy.
 */
const CALIBRATION_LINE =
  "Everybody assumes the expensive option is automatically the better one, but the " +
  "comparison almost never survives contact with the actual numbers — and that " +
  "difference compounds quietly, month after month, until it is impossible to ignore.";

const CALIBRATION_CHARS = CALIBRATION_LINE.length;

/** Rates outside this are a failed measurement, not a slow or fast reader. */
const PLAUSIBLE = { min: 7, max: 26 };

interface PaceRecord {
  charsPerSecond: number;
  measuredAt: string;
}

const CACHE_FILE = () => path.join(config.dataDir, "voice-pace.json");

/**
 * Characters per second for this voice, measuring it once if necessary.
 *
 * Never throws and never blocks a render: any failure yields the default rate.
 */
export async function voicePace(voice: VoiceConfig): Promise<number> {
  const cached = readCache()[cacheKey(voice)];
  if (cached) return cached.charsPerSecond;

  const measured = await measure(voice);
  if (measured === null) return DEFAULT_CHARS_PER_SECOND;

  writeCache(cacheKey(voice), { charsPerSecond: measured, measuredAt: new Date().toISOString() });
  return measured;
}

/**
 * Keyed by voice *and* by the settings that change pacing.
 *
 * Stability and style alter how deliberately a model reads, so a measurement
 * taken at one setting does not describe another. Speed is included for the
 * models that honour it.
 */
function cacheKey(voice: VoiceConfig): string {
  return [voice.voiceId, voice.stability, voice.style, voice.speed].join(":");
}

/**
 * Two takes, and the slower one wins.
 *
 * A single reading is not a reliable measurement: the model's pacing is not
 * repeatable, and the same calibration line in the same voice measured 14.0 and
 * 15.2 characters a second on two runs — an 8% spread, which is wider than the
 * safety margin the budget carries.
 *
 * The error is not symmetric, so neither is the response. Underestimating the
 * rate buys a slightly shorter line and costs nothing anyone notices;
 * overestimating it produces a recording that outlasts the shot and a clip whose
 * lips drift. Taking the minimum of two samples leans the estimate toward the
 * harmless side on purpose.
 */
async function measure(voice: VoiceConfig): Promise<number | null> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < CALIBRATION_SAMPLES; attempt += 1) {
    const rate = await measureOnce(voice);
    if (rate !== null) samples.push(rate);
  }
  return samples.length > 0 ? Math.min(...samples) : null;
}

const CALIBRATION_SAMPLES = 2;

async function measureOnce(voice: VoiceConfig): Promise<number | null> {
  try {
    const provider = voiceProvider();
    const handle = await provider.submit({ text: CALIBRATION_LINE, voice });
    const result = await provider.poll(handle);
    if (result.status !== "succeeded" || !result.urls[0]) return null;

    const bytes = await audioBytes(result.urls[0]);
    if (!bytes) return null;

    const { seconds } = audioDuration(bytes, CALIBRATION_LINE);
    if (!(seconds > 0)) return null;

    const rate = CALIBRATION_CHARS / seconds;
    return rate >= PLAUSIBLE.min && rate <= PLAUSIBLE.max ? rate : null;
  } catch {
    return null;
  }
}

async function audioBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return comma < 0 ? null : Buffer.from(url.slice(comma + 1), "base64");
  }
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

function readCache(): Record<string, PaceRecord> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8")) as Record<string, PaceRecord>;
  } catch {
    // Absent on a fresh install, and unreadable is the same as absent here.
    return {};
  }
}

function writeCache(key: string, record: PaceRecord): void {
  try {
    const next = { ...readCache(), [key]: record };
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(next, null, 2));
  } catch {
    // A cache that cannot be written costs one calibration per render, which is
    // not worth failing the render over.
  }
}
