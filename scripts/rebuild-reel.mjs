#!/usr/bin/env node
/**
 * Rebuild a finished reel locally from media that already exists.
 *
 * No model, provider or network call is made. Inputs are only ever read; every
 * output goes into a NEW directory that must not exist yet.
 *
 *   node scripts/rebuild-reel.mjs \
 *     --manifest render-manifest.json   # scenes: sceneId, videoAssetId, video, audio, caption
 *     --raw-sources raw-sources.json    # one per scene: scene number + videoAssetId -> raw motion
 *     --stills preview-assets.json      # one per scene: sceneId -> approved still (assetId, localPath, meta)
 *     --audio-assets audio.json         # REQUIRED, one per scene: sceneId -> voice assetId + narration file
 *     --out /path/to/new-dir            # must not exist; its parent must
 *     [--headings headings.json]        # optional per-scene heading strings, in scene order
 *     [--trim-eof-transient]            # also drop a short burst confined to the last
 *                                       # 60ms after >=0.25s of silence (off by default:
 *                                       # it is reported, but not provably silence)
 *     [--dry-run]                       # validate and print the plan; write nothing
 *
 * What it fixes, and what it cannot:
 *  - Presenter shots use the retained raw provider motion, at its native 24fps,
 *    frame for frame. A shot is never extended past its real last frame and
 *    nothing is time-stretched. If the raw motion cannot cover the speech plus
 *    a minimum safety margin, the run fails instead.
 *  - Narration keeps the exact recorded waveform. Only trailing audio that is
 *    measured to be silence is left out (after a safety margin), tiny edge
 *    fades are applied, and one static master gain sets loudness. No
 *    resampling, no per-segment loudness, one AAC encode.
 *  - Photo cutaways are re-rendered from the approved still at 24fps with an
 *    oversampled zoom so the move is not quantised to whole output pixels.
 *  - It CANNOT repair lip sync. Presenter mouths in existing clips were
 *    invented by the video model without the recording; recutting does not
 *    change that, and the output manifest says so (lipSyncFixed: false).
 *
 * Identity: sources are matched by exact ID only (videoAssetId, sceneId), and
 * raw-sources scene numbers must equal manifest positions. Missing, duplicate,
 * extra or contradictory entries are refused; nothing is matched by position.
 *
 * Output: the encode goes to <out>/work/reel.partial.mp4. <out>/reel.mp4 appears
 * only after every hard check passed and rebuild-manifest.json was written. On a
 * failed check or SIGINT/SIGTERM/SIGHUP, ffmpeg is killed, FAILED.json is
 * written and no reel.mp4 exists. Soft-check failures are printed as warnings.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);

export const FPS = 24;
export const TOOL = { name: "rebuild-reel", version: 1 };

export const DEFAULTS = Object.freeze({
  width: 720,
  height: 1280,
  /** Preferred room left after the last voiced sample. */
  tailMarginSeconds: 0.3,
  /** The least room ever left after the last voiced sample. */
  minTailMarginSeconds: 0.12,
  /** Any sample louder than this counts as voice when finding the end of speech. */
  speechPeakDbfs: -48,
  /** Window RMS below this counts as a pause (captions only). */
  pauseRmsDbfs: -45,
  minPauseSeconds: 0.12,
  panZoomEnd: 1.06,
  panOversample: 8,
  /** Refuse a centre-crop that would discard more than half the picture. */
  minKeptFraction: 0.5,
  aspectTolerance: 0.01,
  targetLufs: -16,
  maxTruePeakDbtp: -1.5,
  /** Allowance for the AAC encode raising true peak. */
  truePeakHeadroomDb: 0.5,
  /**
   * Activity confined to the final this-many ms of a file, after at least
   * eofTransientGapSeconds of sub-threshold audio, is reported as an
   * end-of-file transient. It is only ever trimmed with --trim-eof-transient.
   */
  eofTransientMs: 60,
  eofTransientGapSeconds: 0.25,
  trimEofTransient: false,
  fadeInMs: 5,
  fadeOutMs: 8,
  crf: 18,
  preset: "medium",
  outputName: "reel.mp4",
});

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

// ---------------------------------------------------------------------------
// ffmpeg plumbing — argument arrays only, never a shell string
// ---------------------------------------------------------------------------

export function resolveFfmpeg(explicit) {
  const bin = explicit ?? require("ffmpeg-static");
  if (!bin || !fs.existsSync(bin)) throw new InputError(`ffmpeg binary not found (${bin ?? "ffmpeg-static"})`);
  return bin;
}

/**
 * Every ffmpeg child is spawned asynchronously and tracked, so a SIGINT/SIGTERM
 * handler can always run and kill it (a handler cannot run while the event loop
 * is blocked in spawnSync). Once a run is aborted no new child starts.
 */
const liveChildren = new Set();
let abortState = null;

export class AbortedError extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.name = "AbortedError";
    this.signal = signal;
  }
}

function runFfmpeg(ffmpeg, args, { cwd, allowFailure = false, stdout: captureStdout = false } = {}) {
  if (abortState) return Promise.reject(new AbortedError(abortState.signal));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], {
      cwd,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    liveChildren.add(child);
    const chunks = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("error", (error) => {
      liveChildren.delete(child);
      reject(error);
    });
    child.on("close", (code, signal) => {
      liveChildren.delete(child);
      if (abortState) return reject(new AbortedError(abortState.signal));
      if (code !== 0 && !allowFailure) {
        return reject(new Error(`ffmpeg failed (${code ?? signal}): ${stderr.split("\n").slice(-15).join("\n")}`));
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, status: code });
    });
  });
}

/**
 * Stop everything: no new ffmpeg starts, every running one gets SIGKILL.
 * Resolves once they have all exited (or after timeoutMs).
 */
export function abortChildren(signal, timeoutMs = 5000) {
  abortState ??= { signal };
  const children = [...liveChildren];
  const exited = children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  }));
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  let timer;
  return Promise.race([
    Promise.all(exited),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function killChildrenNow() {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function throwIfAborted() {
  if (abortState) throw new AbortedError(abortState.signal);
}

/** Stream description from `ffmpeg -i` (no ffprobe ships with ffmpeg-static). */
export async function probe(ffmpeg, file) {
  const { stderr } = await runFfmpeg(ffmpeg, ["-i", file], { allowFailure: true });
  const video = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]+)/.exec(stderr);
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: ([^\n]+)/.exec(stderr);
  const out = { file, video: null, audio: null };
  if (video) {
    const size = /(?:^|[ ,])(\d{2,6})x(\d{2,6})(?:[ ,\[]|$)/.exec(video[1]);
    const fps = /([\d.]+) fps/.exec(video[1]);
    out.video = {
      codec: video[1].split(/[ ,]/)[0],
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      fps: fps ? Number(fps[1]) : null,
    };
  }
  if (audio) {
    const rate = /(\d+) Hz/.exec(audio[1]);
    const layout = /Hz, ([^,]+)/.exec(audio[1]);
    out.audio = {
      codec: audio[1].split(/[ ,]/)[0],
      sampleRate: rate ? Number(rate[1]) : null,
      layout: layout ? layout[1].trim() : null,
    };
  }
  return out;
}

/**
 * Decode every video frame and hash it. Gives the real frame count, the real
 * timestamps (to prove a constant rate) and exact repeats.
 */
export async function frameHashes(ffmpeg, file) {
  const { stdout } = await runFfmpeg(ffmpeg, ["-loglevel", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { stdout: true });
  const text = stdout.toString("utf8");
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(text);
  const timeBase = tb ? Number(tb[1]) / Number(tb[2]) : null;
  const frames = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(",").map((c) => c.trim());
    frames.push({ pts: Number(cols[2]), duration: Number(cols[3]), md5: cols[5] });
  }
  return { timeBase, frames };
}

export async function frameStats(ffmpeg, file) {
  const { timeBase, frames } = await frameHashes(ffmpeg, file);
  const deltas = new Set();
  for (let i = 1; i < frames.length; i += 1) deltas.add(frames[i].pts - frames[i - 1].pts);
  const step = deltas.size === 1 ? [...deltas][0] * timeBase : null;
  return {
    frames: frames.length,
    timeBase,
    uniformStepSeconds: step,
    fpsFromTimestamps: step ? Math.round((1 / step) * 1000) / 1000 : null,
    md5: frames.map((f) => f.md5),
  };
}

/** Longest run of consecutive byte-identical decoded frames in [from, to). */
export function longestIdenticalRun(md5, from = 0, to = md5.length) {
  let best = md5.length ? 1 : 0;
  let run = 1;
  for (let i = from + 1; i < to; i += 1) {
    run = md5[i] === md5[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Native-rate mono float samples. Returns the rate it decoded at. */
export async function decodeMono(ffmpeg, file) {
  const info = await probe(ffmpeg, file);
  if (!info.audio?.sampleRate) throw new InputError(`${file}: no audio stream`);
  const { stdout } = await runFfmpeg(ffmpeg, [
    "-loglevel", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-acodec", "pcm_f32le", "-",
  ], { stdout: true });
  const copy = Buffer.from(stdout);
  return {
    sampleRate: info.audio.sampleRate,
    layout: info.audio.layout,
    samples: new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const dbToAmp = (db) => 10 ** (db / 20);
const ampToDb = (amp) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);
const round = (value, places = 4) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : value);

/**
 * Where the speech is.
 *
 * The end of speech is the last sample louder than `speechPeakDbfs` — a
 * per-sample peak test, so a soft final syllable or breath still counts as
 * voice. Pause regions (for caption timing only) come from 10ms RMS windows.
 */
export function analyzeSpeech(samples, sampleRate, opts = DEFAULTS) {
  const peakThreshold = dbToAmp(opts.speechPeakDbfs);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > peakThreshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const durationSeconds = samples.length / sampleRate;
  if (last < 0) return { durationSeconds, speechStartSeconds: null, speechEndSeconds: null, regions: [], eofTransient: null };

  // A short burst at the very end of the file, separated from the speech by a
  // clear gap: typically a codec/onset artifact, but not provably silence.
  let eofTransient = null;
  const eofWindow = Math.round((opts.eofTransientMs / 1000) * sampleRate);
  if (samples.length - last <= eofWindow) {
    const join = Math.round(0.01 * sampleRate);
    let burstStart = last;
    let prev = -1;
    for (let i = last - 1; i >= 0; i -= 1) {
      if (Math.abs(samples[i]) > peakThreshold) {
        if (burstStart - i <= join) burstStart = i;
        else {
          prev = i;
          break;
        }
      }
    }
    const gap = (burstStart - prev - 1) / sampleRate;
    if (prev >= 0 && samples.length - burstStart <= eofWindow && gap >= opts.eofTransientGapSeconds) {
      let peak = 0;
      for (let i = burstStart; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
      eofTransient = {
        startSeconds: round(burstStart / sampleRate, 5),
        lengthMs: round(((samples.length - burstStart) / sampleRate) * 1000, 2),
        peakDbfs: round(ampToDb(peak), 2),
        gapBeforeSeconds: round(gap, 4),
        speechEndBeforeSeconds: (prev + 1) / sampleRate,
        trimmed: false,
      };
    }
  }

  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const rmsThreshold = dbToAmp(opts.pauseRmsDbfs);
  const voiced = [];
  for (let start = 0; start < samples.length; start += win) {
    let sum = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    voiced.push(Math.sqrt(sum / (end - start)) > rmsThreshold);
  }
  const raw = [];
  for (let w = 0; w < voiced.length; w += 1) {
    if (!voiced[w]) continue;
    const s = (w * win) / sampleRate;
    const e = Math.min(durationSeconds, ((w + 1) * win) / sampleRate);
    const prev = raw.at(-1);
    if (prev && s - prev[1] < opts.minPauseSeconds) prev[1] = e;
    else raw.push([s, e]);
  }
  const regions = raw.map(([s, e]) => ({ start: s, end: e }));
  // Where sustained (10ms-RMS) voice ends: what a listener hears as the end of
  // the line, used for reporting the silence across each cut.
  const sustained = regions.filter((r) => r.end - r.start >= 0.03);
  let speechEndSeconds = (last + 1) / sampleRate;
  if (eofTransient && opts.trimEofTransient) {
    speechEndSeconds = eofTransient.speechEndBeforeSeconds;
    eofTransient.trimmed = true;
  }
  return {
    durationSeconds,
    speechStartSeconds: first / sampleRate,
    speechEndSeconds,
    sustainedSpeechStartSeconds: sustained.length ? sustained[0].start : first / sampleRate,
    sustainedSpeechEndSeconds: sustained.length ? sustained.at(-1).end : speechEndSeconds,
    regions,
    eofTransient,
  };
}

/** Integrated loudness and true peak via ffmpeg's EBU R128 analyser. */
export async function measureLoudness(ffmpeg, file, extraFilter = null) {
  const filter = [extraFilter, "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json"].filter(Boolean).join(",");
  const { stderr } = await runFfmpeg(ffmpeg, ["-i", file, "-map", "0:a:0", "-af", filter, "-f", "null", "-"]);
  const json = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!json) throw new Error(`could not read loudness for ${file}`);
  const parsed = JSON.parse(json[0]);
  return { integratedLufs: Number(parsed.input_i), truePeakDbtp: Number(parsed.input_tp), lra: Number(parsed.input_lra) };
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new InputError(`${label} (${file}) is not readable JSON: ${error.message}`);
  }
}

function requireFile(file, label) {
  if (typeof file !== "string" || !file) throw new InputError(`${label}: path missing`);
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new InputError(`${label}: file not found: ${resolved}`);
  return resolved;
}

/**
 * How a source of one shape fills a frame of another without distortion.
 * Within tolerance: plain scale. Otherwise a centred crop, refused when it
 * would discard more than (1 - minKeptFraction) of the picture.
 */
export function aspectPlan(srcW, srcH, outW, outH, opts = DEFAULTS, label = "source") {
  const ratio = srcW / srcH / (outW / outH);
  if (Math.abs(ratio - 1) <= opts.aspectTolerance) {
    return { action: srcW === outW && srcH === outH ? "none" : "scale", keptFraction: 1, sourceAspect: round(srcW / srcH) };
  }
  const keptFraction = ratio > 1 ? 1 / ratio : ratio;
  if (keptFraction < opts.minKeptFraction) {
    throw new InputError(
      `${label}: aspect ratio ${srcW}x${srcH} does not fit ${outW}x${outH}; a centre crop would keep only ` +
        `${Math.round(keptFraction * 100)}% of the picture. Supply a still/clip framed for the output aspect.`,
    );
  }
  return { action: "center-crop", keptFraction: round(keptFraction), sourceAspect: round(srcW / srcH) };
}

/**
 * Frames for one scene. Never fewer than the speech needs; never more than the
 * motion source has. Returns null with a reason when that is impossible.
 */
export function planFrames({ durationSeconds, speechEndSeconds, sourceFrames }, opts = DEFAULTS) {
  const wanted = Math.min(durationSeconds, speechEndSeconds + opts.tailMarginSeconds);
  const floorSeconds = Math.min(durationSeconds, speechEndSeconds + opts.minTailMarginSeconds);
  const preferred = Math.ceil(wanted * FPS - 1e-9);
  const minimum = Math.ceil(floorSeconds * FPS - 1e-9);
  if (sourceFrames == null) return { frames: preferred, minimum, preferred };
  if (sourceFrames < minimum) return { frames: null, minimum, preferred };
  return { frames: Math.min(preferred, sourceFrames), minimum, preferred };
}

/** Split caption text into short readable phrases. */
export function captionPhrases(text) {
  const sentences = String(text ?? "").trim().split(/(?<=[.!?;:])\s+/).filter(Boolean);
  const out = [];
  for (const sentence of sentences) {
    if (sentence.length <= 42) {
      out.push(sentence);
      continue;
    }
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      // Balanced rather than greedy, so a long clause does not leave a
      // two-word orphan on its own caption.
      const words = clause.split(/\s+/);
      const parts = Math.max(Math.ceil(clause.length / 42), Math.ceil(words.length / 8));
      const per = Math.ceil(words.length / parts);
      for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
    }
  }
  return out;
}

/**
 * Approximate phrase timing inside one edited scene window: phrase lengths
 * (characters) are laid over the measured voiced regions, and a boundary that
 * lands near a measured pause snaps to it. This is NOT forced alignment.
 */
export function timeCaptions(phrases, regions, windowSeconds) {
  const voiced = regions
    .map((r) => ({ start: r.start, end: Math.min(r.end, windowSeconds) }))
    .filter((r) => r.end > r.start);
  if (!phrases.length || !voiced.length) return [];
  const total = voiced.reduce((n, r) => n + (r.end - r.start), 0);
  const weights = phrases.map((p) => Math.max(1, p.replace(/\s+/g, "").length));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const at = (voicedSeconds) => {
    let left = voicedSeconds;
    for (const r of voiced) {
      const len = r.end - r.start;
      if (left <= len) return r.start + left;
      left -= len;
    }
    return voiced.at(-1).end;
  };
  const gaps = voiced.slice(1).map((r, i) => ({ start: voiced[i].end, end: r.start }));
  const bounds = [];
  let acc = 0;
  for (let i = 0; i < phrases.length - 1; i += 1) {
    acc += weights[i];
    const b = at((total * acc) / weightSum);
    const near = gaps
      .map((g) => ({ g, d: Math.abs((g.start + g.end) / 2 - b) }))
      .filter((x) => x.d <= 0.5)
      .sort((x, y) => x.d - y.d)[0];
    bounds.push(near ? { end: Math.min(near.g.end, near.g.start + 0.15), start: Math.max(near.g.start, near.g.end - 0.05), snapped: true } : { end: b, start: b, snapped: false });
  }
  const first = Math.max(0, voiced[0].start - 0.05);
  const last = Math.min(windowSeconds - 0.04, voiced.at(-1).end + 0.4);
  return phrases.map((text, i) => ({
    text,
    start: round(i === 0 ? first : bounds[i - 1].start, 3),
    end: round(i === phrases.length - 1 ? Math.max(last, i === 0 ? first + 0.3 : bounds[i - 1].start + 0.3) : bounds[i].end, 3),
    snappedToPause: i < phrases.length - 1 ? bounds[i].snapped : false,
  })).map((c) => ({ ...c, end: round(Math.min(c.end, windowSeconds), 3) }));
}

/**
 * Strict scene identity. The manifest's order is the reel's order; every
 * lookup map must hold exactly one entry per manifest scene, found by exact
 * ID — never by array position. Anything missing, duplicated, extra or
 * contradictory is refused before any media is read.
 *
 *  - manifest scenes: unique non-empty sceneId and videoAssetId
 *  - --raw-sources: one entry per scene; its videoAssetId must equal the
 *    manifest's, and its `scene` number must equal the manifest position
 *  - --stills: one entry per sceneId (unique sceneId and assetId)
 *  - --audio-assets (required): one entry per sceneId (unique sceneId, assetId
 *    and file); the file must be the manifest narration for that scene, and a
 *    raw-sources voiceAssetId, when present, must agree with it
 */
export function resolveSceneSources({ manifest, rawSources, stills, audioAssets }) {
  const scenes = manifest.scenes;
  const n = scenes.length;
  const isId = (v) => typeof v === "string" && v.trim() !== "";
  const unique = (list, key, label) => {
    const seen = new Map();
    list.forEach((item, i) => {
      const value = item[key];
      if (value === null || value === undefined) return;
      if (seen.has(value)) {
        throw new InputError(`${label}: duplicate ${key} ${JSON.stringify(value)} (entries ${seen.get(value) + 1} and ${i + 1})`);
      }
      seen.set(value, i);
    });
  };
  const resolvedPath = (file) => (typeof file === "string" && file ? path.resolve(file) : null);

  scenes.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") throw new InputError(`--manifest scene ${i + 1} is not an object`);
    if (!isId(entry.sceneId)) throw new InputError(`--manifest scene ${i + 1}: sceneId missing`);
    if (!isId(entry.videoAssetId)) {
      throw new InputError(
        `--manifest scene ${i + 1} (${entry.sceneId}): videoAssetId missing; every scene must name its exact video ` +
          `asset (refusing to map sources by position)`,
      );
    }
  });
  unique(scenes, "sceneId", "--manifest");
  unique(scenes, "videoAssetId", "--manifest");
  unique(scenes.map((e) => ({ audio: resolvedPath(e.audio) })), "audio", "--manifest narration");

  // --- raw-sources ---------------------------------------------------------
  if (rawSources.length !== n) {
    throw new InputError(`--raw-sources has ${rawSources.length} entries but --manifest has ${n} scenes; expected exactly one per scene`);
  }
  rawSources.forEach((r, k) => {
    if (!r || typeof r !== "object") throw new InputError(`--raw-sources entry ${k + 1} is not an object`);
    if (!Number.isInteger(r.scene) || r.scene < 1 || r.scene > n) {
      throw new InputError(`--raw-sources entry ${k + 1}: scene number ${JSON.stringify(r.scene)} is not an integer 1..${n}`);
    }
    if (!isId(r.videoAssetId)) throw new InputError(`--raw-sources entry ${k + 1} (scene ${r.scene}): videoAssetId missing`);
  });
  unique(rawSources, "scene", "--raw-sources");
  unique(rawSources, "videoAssetId", "--raw-sources");
  unique(rawSources.map((r) => ({ rawMotionPath: resolvedPath(r.rawMotionPath) })), "rawMotionPath", "--raw-sources");
  const rawById = new Map(rawSources.map((r) => [r.videoAssetId, r]));
  const rawByScene = new Map(rawSources.map((r) => [r.scene, r]));

  // --- stills --------------------------------------------------------------
  const sceneIds = new Set(scenes.map((e) => e.sceneId));
  const bySceneId = (list, label) => {
    if (list.length !== n) throw new InputError(`${label} has ${list.length} entries but --manifest has ${n} scenes; expected exactly one per scene`);
    list.forEach((item, k) => {
      if (!item || typeof item !== "object") throw new InputError(`${label} entry ${k + 1} is not an object`);
      if (!isId(item.sceneId)) throw new InputError(`${label} entry ${k + 1}: sceneId missing`);
      if (!isId(item.assetId)) throw new InputError(`${label} entry ${k + 1} (${item.sceneId}): assetId missing`);
      if (!sceneIds.has(item.sceneId)) throw new InputError(`${label} entry ${k + 1}: sceneId ${item.sceneId} is not a --manifest scene`);
    });
    unique(list, "sceneId", label);
    unique(list, "assetId", label);
    return new Map(list.map((item) => [item.sceneId, item]));
  };
  const stillBySceneId = bySceneId(stills, "--stills");

  // --- audio assets (required: the only proof of which voice take is used) --
  if (!audioAssets) {
    throw new InputError(
      "--audio-assets is required: it is the only proof of which voice asset each narration file is, and no " +
        "voiceAssetId is recorded without it",
    );
  }
  if (!Array.isArray(audioAssets)) throw new InputError("--audio-assets must be an array");
  audioAssets.forEach((a, k) => {
    if (typeof a?.file !== "string" || !a.file) throw new InputError(`--audio-assets entry ${k + 1}: file missing`);
  });
  const audioBySceneId = bySceneId(audioAssets, "--audio-assets");
  unique(audioAssets.map((a) => ({ file: resolvedPath(a.file) })), "file", "--audio-assets");

  // --- per scene: exact ID lookups, cross-checked against position ----------
  return scenes.map((entry, i) => {
    const position = i + 1;
    const label = `scene ${position} (${entry.sceneId})`;
    const raw = rawById.get(entry.videoAssetId);
    const atPosition = rawByScene.get(position);
    if (!raw) {
      throw new InputError(
        `${label}: videoAssetId ${entry.videoAssetId} is not in --raw-sources` +
          (atPosition ? ` (raw-sources scene ${position} is ${atPosition.videoAssetId})` : "") +
          "; refusing to fall back to position",
      );
    }
    if (raw.scene !== position) {
      throw new InputError(
        `${label}: videoAssetId ${entry.videoAssetId} is raw-sources scene number ${raw.scene} but sits at manifest ` +
          `position ${position}; manifest order and raw-sources scene numbers disagree`,
      );
    }
    const still = stillBySceneId.get(entry.sceneId);
    const asset = audioBySceneId.get(entry.sceneId);
    const narration = requireFile(entry.audio, `${label} narration`);
    const assetFile = requireFile(asset.file, `${label} --audio-assets file`);
    if (fs.realpathSync(narration) !== fs.realpathSync(assetFile)) {
      throw new InputError(`${label}: narration ${narration} is not the --audio-assets file ${assetFile} for voice asset ${asset.assetId}`);
    }
    if (raw.voiceAssetId != null && raw.voiceAssetId !== asset.assetId) {
      throw new InputError(`${label}: voice asset ${asset.assetId} (--audio-assets) != raw-sources voiceAssetId ${raw.voiceAssetId}`);
    }
    return {
      entry,
      raw,
      still,
      narration,
      voice: {
        assetId: asset.assetId,
        check: `--audio-assets entry for ${entry.sceneId} names this exact narration file` +
          (raw.voiceAssetId != null ? "; raw-sources voiceAssetId agrees" : "; raw-sources has no voiceAssetId"),
      },
    };
  });
}

/**
 * Validate every input and decide every cut. Reads only; writes nothing.
 */
export async function buildPlan(options) {
  const opts = { ...DEFAULTS, ...options.tuning };
  const ffmpeg = resolveFfmpeg(options.ffmpeg);
  const outW = opts.width;
  const outH = opts.height;
  if (outW % 2 || outH % 2) throw new InputError("--width and --height must be even");

  if (!options.audioAssets) {
    throw new InputError(
      "--audio-assets is required: it is the only proof of which voice asset each narration file is, and no " +
        "voiceAssetId is recorded without it",
    );
  }
  const files = {
    manifest: requireFile(options.manifest, "--manifest"),
    rawSources: requireFile(options.rawSources, "--raw-sources"),
    stills: requireFile(options.stills, "--stills"),
    audioAssets: requireFile(options.audioAssets, "--audio-assets"),
    headings: options.headings ? requireFile(options.headings, "--headings") : null,
  };
  const manifest = readJson(files.manifest, "--manifest");
  const rawSources = readJson(files.rawSources, "--raw-sources");
  const stills = readJson(files.stills, "--stills");
  const audioAssets = readJson(files.audioAssets, "--audio-assets");
  const headings = files.headings ? readJson(files.headings, "--headings") : null;
  if (!Array.isArray(manifest?.scenes) || manifest.scenes.length === 0) throw new InputError("--manifest has no scenes[]");
  if (!Array.isArray(rawSources)) throw new InputError("--raw-sources must be an array");
  if (!Array.isArray(stills)) throw new InputError("--stills must be an array");
  if (headings && (!Array.isArray(headings) || headings.length !== manifest.scenes.length)) {
    throw new InputError("--headings must be an array with one entry per manifest scene");
  }
  const sources = resolveSceneSources({ manifest, rawSources, stills, audioAssets });

  let sampleRate = null;
  const scenes = [];
  for (const [index, { entry, raw, still, narration: audioFile, voice }] of sources.entries()) {
    const label = `scene ${index + 1} (${entry.sceneId})`;

    const narration = await decodeMono(ffmpeg, audioFile);
    if (sampleRate === null) sampleRate = narration.sampleRate;
    if (narration.sampleRate !== sampleRate) {
      throw new InputError(`${label}: narration is ${narration.sampleRate} Hz but earlier scenes are ${sampleRate} Hz; refusing to resample`);
    }
    const speech = analyzeSpeech(narration.samples, narration.sampleRate, opts);
    if (speech.speechEndSeconds === null) throw new InputError(`${label}: no speech detected in ${audioFile}`);

    // The clip the previous export used, measured for the audit trail only.
    let previousClip = null;
    if (entry.video && fs.existsSync(entry.video)) {
      const p = await probe(ffmpeg, path.resolve(entry.video));
      const st = await frameStats(ffmpeg, path.resolve(entry.video));
      previousClip = { path: path.resolve(entry.video), fps: p.video?.fps ?? null, frames: st.frames, seconds: p.video?.fps ? round(st.frames / p.video.fps) : null, used: false };
    }

    let kind;
    let motionFile = null;
    if (raw.rawMotionPath) {
      kind = "presenter-raw-motion";
      motionFile = requireFile(raw.rawMotionPath, `${label} raw motion`);
    } else if ((still.meta?.provider === "licensed-source-photo" || still.cutaway === true)) {
      kind = "photo-pan";
    } else {
      kind = "existing-clip";
      motionFile = requireFile(entry.video, `${label} clip`);
    }

    const scene = {
      index: index + 1,
      sceneId: entry.sceneId,
      videoAssetId: entry.videoAssetId,
      rawSourceScene: raw.scene,
      voiceAssetId: voice.assetId,
      voiceAssetVerified: true,
      voiceAssetCheck: voice.check,
      stillAssetId: still.assetId,
      kind,
      caption: entry.caption ?? "",
      heading: headings ? String(headings[index] ?? "") : "",
      audio: {
        source: audioFile,
        sampleRate: narration.sampleRate,
        sourceLayout: narration.layout,
        sourceSamples: narration.samples.length,
        durationSeconds: round(speech.durationSeconds),
        speechStartSeconds: round(speech.speechStartSeconds),
        speechEndSeconds: round(speech.speechEndSeconds),
        sustainedSpeechStartSeconds: round(speech.sustainedSpeechStartSeconds),
        sustainedSpeechEndSeconds: round(speech.sustainedSpeechEndSeconds),
        trailingSilenceSeconds: round(speech.durationSeconds - speech.speechEndSeconds),
        eofTransient: speech.eofTransient
          ? (({ speechEndBeforeSeconds, ...rest }) => ({ ...rest, speechEndBeforeSeconds: round(speechEndBeforeSeconds) }))(speech.eofTransient)
          : null,
      },
      regions: speech.regions,
      previousClip,
      _samples: narration.samples,
    };

    if (kind === "photo-pan") {
      const stillFile = requireFile(still.localPath, `${label} approved still`);
      const p = await probe(ffmpeg, stillFile);
      if (!p.video?.width) throw new InputError(`${label}: cannot read still ${stillFile}`);
      const aspect = aspectPlan(p.video.width, p.video.height, outW, outH, opts, `${label} still`);
      const plan = planFrames({ durationSeconds: speech.durationSeconds, speechEndSeconds: speech.speechEndSeconds }, opts);
      scene.still = { source: stillFile, assetId: still.assetId ?? null, width: p.video.width, height: p.video.height, declaredAspect: still.meta?.aspectRatio ?? null, aspect };
      scene.frames = plan.frames;
      scene.pan = {
        oversample: opts.panOversample,
        zoomStart: 1,
        zoomEnd: opts.panZoomEnd,
        // How far the crop edge travels per frame, in output pixels.
        cropStepOutputPixels: round(((outW * (1 - 1 / opts.panZoomEnd)) / Math.max(1, plan.frames - 1)), 4),
        cropQuantumOutputPixels: round(1 / opts.panOversample, 4),
      };
    } else {
      const p = await probe(ffmpeg, motionFile);
      if (!p.video?.width) throw new InputError(`${label}: no video stream in ${motionFile}`);
      if (p.video.fps !== FPS) {
        throw new InputError(`${label}: ${motionFile} is ${p.video.fps}fps; this exporter only cuts 24fps motion and will not convert frame rates`);
      }
      const st = await frameStats(ffmpeg, motionFile);
      if (st.fpsFromTimestamps !== null && Math.abs(st.fpsFromTimestamps - FPS) > 0.01) {
        throw new InputError(`${label}: ${motionFile} timestamps step at ${st.fpsFromTimestamps}fps, not 24fps`);
      }
      const aspect = aspectPlan(p.video.width, p.video.height, outW, outH, opts, `${label} motion`);
      const plan = planFrames({ durationSeconds: speech.durationSeconds, speechEndSeconds: speech.speechEndSeconds, sourceFrames: st.frames }, opts);
      if (plan.frames === null) {
        throw new InputError(
          `${label}: insufficient motion — ${motionFile} has ${st.frames} frames (${round(st.frames / FPS, 3)}s) but speech ` +
            `ends at ${round(speech.speechEndSeconds, 3)}s and needs at least ${plan.minimum} frames ` +
            `(speech end + ${opts.minTailMarginSeconds}s). Refusing to freeze or stretch the shot; supply longer motion.`,
        );
      }
      scene.frames = plan.frames;
      scene.video = {
        source: motionFile,
        sourceFps: p.video.fps,
        sourceFrames: st.frames,
        sourceSeconds: round(st.frames / FPS),
        sourceWidth: p.video.width,
        sourceHeight: p.video.height,
        sourceLongestIdenticalRun: longestIdenticalRun(st.md5),
        sourceTailIdenticalRun: tailRun(st.md5, plan.frames),
        aspect,
        framesUsed: plan.frames,
        framesUnused: st.frames - plan.frames,
        sourceInSeconds: 0,
        sourceOutSeconds: round(plan.frames / FPS),
      };
    }
    scenes.push(scene);
  }

  // Timeline: frame-exact, with audio boundaries derived from the same frame
  // positions so cumulative rounding never drifts.
  let frameCursor = 0;
  for (const scene of scenes) {
    const startSample = Math.round((frameCursor * sampleRate) / FPS);
    const endSample = Math.round(((frameCursor + scene.frames) * sampleRate) / FPS);
    const length = endSample - startSample;
    const kept = Math.min(length, scene.audio.sourceSamples);
    // Everything left out must be below the voice threshold — except an
    // end-of-file transient the operator explicitly opted to drop.
    const transient = scene.audio.eofTransient?.trimmed ? scene.audio.eofTransient : null;
    const strictEnd = transient ? Math.round(transient.startSeconds * sampleRate) : scene._samples.length;
    let trimmedPeak = 0;
    for (let i = kept; i < strictEnd; i += 1) trimmedPeak = Math.max(trimmedPeak, Math.abs(scene._samples[i]));
    if (kept / sampleRate < scene.audio.speechEndSeconds - 1e-9 || trimmedPeak > dbToAmp(opts.speechPeakDbfs)) {
      throw new InputError(`scene ${scene.index}: planned cut would remove voiced audio (internal error, refusing)`);
    }
    scene.timeline = {
      startFrame: frameCursor,
      frames: scene.frames,
      startSeconds: round(frameCursor / FPS, 6),
      seconds: round(scene.frames / FPS, 6),
      startSample,
      samples: length,
    };
    Object.assign(scene.audio, {
      keptSamples: kept,
      keptSeconds: round(kept / sampleRate),
      trimmedTrailingSeconds: round((scene.audio.sourceSamples - kept) / sampleRate),
      // -200 stands for exact digital silence (JSON has no -Infinity).
      trimmedRegionPeakDbfs: kept < scene.audio.sourceSamples ? round(Math.max(-200, ampToDb(trimmedPeak)), 2) : null,
      trimmedRegionDigitalSilence: kept < scene.audio.sourceSamples ? trimmedPeak === 0 : null,
      paddedSilenceSeconds: round((length - kept) / sampleRate),
      marginAfterSpeechSeconds: round(kept / sampleRate - scene.audio.speechEndSeconds),
    });
    const local = timeCaptions(captionPhrases(scene.caption), scene.regions, scene.timeline.seconds);
    scene.captions = local.map((c) => ({ ...c, start: round(c.start + scene.timeline.startSeconds, 3), end: round(c.end + scene.timeline.startSeconds, 3) }));
    scene.lipSyncApplicable = scene.kind !== "photo-pan";
    scene.lipSyncFixed = scene.kind === "photo-pan" ? null : false;
    frameCursor += scene.frames;
  }
  // Gap a listener hears at each cut: from the end of sustained voice in the
  // outgoing scene to the start of sustained voice in the incoming one.
  for (let i = 1; i < scenes.length; i += 1) {
    const prev = scenes[i - 1];
    const prevEnd = Math.min(prev.audio.sustainedSpeechEndSeconds, prev.timeline.seconds);
    scenes[i].silenceAcrossCutBeforeSeconds = round(
      prev.timeline.seconds - prevEnd + scenes[i].audio.sustainedSpeechStartSeconds,
      3,
    );
  }

  return { opts, ffmpeg, files, manifest, scenes, sampleRate, totalFrames: frameCursor, width: outW, height: outH };
}

function tailRun(md5, upTo) {
  let run = 1;
  for (let i = upTo - 1; i > 0 && md5[i] === md5[i - 1]; i -= 1) run += 1;
  return run;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function writeFloatWav(file, channels, sampleRate) {
  const frames = channels[0].length;
  const data = Buffer.alloc(frames * channels.length * 4);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels.length; c += 1) data.writeFloatLE(channels[c][i], (i * channels.length + c) * 4);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels.length * 4, 28);
  header.writeUInt16LE(channels.length * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]), { flag: "wx" });
}

/** One continuous narration track: exact samples, tiny edge fades, nothing else. */
export function assembleNarration(plan) {
  const { scenes, sampleRate, totalFrames, opts } = plan;
  const total = Math.round((totalFrames * sampleRate) / FPS);
  const master = new Float32Array(total);
  const fadeIn = Math.round((opts.fadeInMs / 1000) * sampleRate);
  const fadeOut = Math.round((opts.fadeOutMs / 1000) * sampleRate);
  for (const scene of scenes) {
    const { startSample, samples } = scene.timeline;
    const src = scene._samples;
    for (let i = 0; i < scene.audio.keptSamples; i += 1) master[startSample + i] = src[i];
    for (let i = 0; i < Math.min(fadeIn, samples); i += 1) master[startSample + i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    for (let i = 0; i < Math.min(fadeOut, samples); i += 1) {
      const k = startSample + samples - 1 - i;
      master[k] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut);
    }
    scene.audio.fadeInSeconds = round(fadeIn / sampleRate, 5);
    scene.audio.fadeOutSeconds = round(fadeOut / sampleRate, 5);
    scene.audio.fadeInTouchesSpeech = scene.audio.speechStartSeconds < fadeIn / sampleRate;
  }
  return master;
}

function assText(value) {
  return String(value).replace(/\\/g, "/").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
}

function wrap(text, width = 34) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function captionFiles(plan) {
  const { width: W, height: H } = plan;
  const k = H / 1280;
  const px = (n) => Math.max(1, Math.round(n * k));
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Label,DejaVu Sans,${px(27)},&H00FFFFFF,&H00FFFFFF,&H00202020,&H70000000,-1,0,0,0,100,100,1,0,1,${px(2)},${px(1)},8,${px(45)},${px(45)},${px(95)},1`,
    `Style: Caption,DejaVu Sans,${px(30)},&H00FFFFFF,&H00FFFFFF,&H00101010,&H70000000,-1,0,0,0,100,100,0,0,1,${px(2)},${px(1)},2,${px(50)},${px(50)},${px(180)},1`,
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const srt = [];
  for (const scene of plan.scenes) {
    const s0 = scene.timeline.startSeconds;
    const s1 = s0 + scene.timeline.seconds;
    if (scene.heading.trim() && scene.timeline.seconds > 0.5) {
      const text = scene.heading.split(/\r?\n|\\N/).map(assText).join("\\N");
      ass.push(`Dialogue: 0,${assTime(s0 + 0.1)},${assTime(s1 - 0.1)},Label,,0,0,0,,${text}`);
    }
    for (const c of scene.captions) {
      ass.push(`Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${wrap(assText(c.text)).join("\\N")}`);
      srt.push(`${srt.length + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`);
    }
  }
  return { ass: ass.join("\n") + "\n", srt: srt.join("\n") };
}

/** One filter graph, one encode. Inputs are referenced by absolute path. */
export function encodeArgs(plan, { assName, wavName, outputName }) {
  const { scenes, width: W, height: H, opts } = plan;
  const inputs = [];
  const chains = [];
  scenes.forEach((scene, i) => {
    const N = scene.frames;
    if (scene.kind === "photo-pan") {
      inputs.push("-i", scene.still.source);
      const os = opts.panOversample;
      const zStep = N > 1 ? (opts.panZoomEnd - 1) / (N - 1) : 0;
      chains.push(
        `[${i}:v]scale=${W * os}:${H * os}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${W * os}:${H * os},setsar=1,format=yuv420p,` +
          `zoompan=z='1+${zStep.toFixed(10)}*on':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${N}:s=${W}x${H}:fps=${FPS},` +
          `setsar=1,setpts=N/${FPS}/TB,format=yuv420p[v${i}]`,
      );
    } else {
      inputs.push("-i", scene.video.source);
      const fit = scene.video.aspect.action === "none"
        ? "setsar=1"
        : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`;
      // trim keeps source frames 0..N-1 exactly; setpts restamps them on the
      // 24fps grid without adding or dropping any.
      chains.push(`[${i}:v]trim=end_frame=${N},setpts=N/${FPS}/TB,${fit},format=yuv420p[v${i}]`);
    }
  });
  const concatIn = scenes.map((_, i) => `[v${i}]`).join("");
  chains.push(`${concatIn}concat=n=${scenes.length}:v=1:a=0[vc]`);
  chains.push(`[vc]ass=filename=${assName}[vout]`);
  inputs.push("-i", wavName);
  return [
    "-loglevel", "error", "-n",
    ...inputs,
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", `${scenes.length}:a:0`,
    "-c:v", "libx264", "-preset", opts.preset, "-crf", String(opts.crf), "-pix_fmt", "yuv420p",
    // Timestamps are already exact on the 24fps grid, so CFR output neither
    // duplicates nor drops anything (the frame-count check proves it); it
    // just gives the last frame its full 1/24s so the stream reads as 24fps.
    "-fps_mode", "cfr", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(plan.sampleRate), "-ac", "2",
    "-movflags", "+faststart",
    outputName,
  ];
}

function publicScene(scene) {
  const { _samples, regions, frames, ...rest } = scene;
  return { ...rest, measuredVoicedRegions: regions.map((r) => ({ start: round(r.start, 3), end: round(r.end, 3) })) };
}

/**
 * State of the run in progress, so a signal handler can leave a truthful
 * failure marker. `published` flips only after reel.mp4 exists.
 */
const activeRun = { out: null, published: false };

const PARTIAL_NAME = path.join("work", "reel.partial.mp4");

/** Move an unpublished success manifest out of the way and record the failure. */
function writeFailureMarker(out, details) {
  const manifest = path.join(out, "rebuild-manifest.json");
  let manifestMovedTo = null;
  if (fs.existsSync(manifest)) {
    manifestMovedTo = path.join("work", "rebuild-manifest.unpublished.json");
    fs.renameSync(manifest, path.join(out, manifestMovedTo));
  }
  const partial = path.join(out, PARTIAL_NAME);
  fs.writeFileSync(
    path.join(out, "FAILED.json"),
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        published: false,
        statement: "No reel.mp4 was published. Files under work/ are unverified debug intermediates.",
        unverifiedPartialOutput: fs.existsSync(partial) ? PARTIAL_NAME : null,
        unpublishedManifest: manifestMovedTo,
        ...details,
      },
      null,
      2,
    ) + "\n",
  );
}

/** Called by the CLI's signal handler once every child is dead. */
export function markRunInterrupted(signal) {
  const { out, published } = activeRun;
  if (!out || published || !fs.existsSync(out)) return false;
  writeFailureMarker(out, { error: `interrupted by ${signal}`, signal });
  return true;
}

export async function rebuild(options, log = () => {}) {
  const out = path.resolve(options.out ?? "");
  if (!options.out) throw new InputError("--out is required");
  if (fs.existsSync(out)) throw new InputError(`output directory already exists: ${out} (refusing to overwrite)`);
  if (!fs.existsSync(path.dirname(out))) throw new InputError(`parent of --out does not exist: ${path.dirname(out)}`);

  const plan = await buildPlan(options);
  const { ffmpeg, opts, scenes } = plan;

  // Everything that was read, hashed before anything is written.
  const inputFiles = new Set(Object.values(plan.files).filter(Boolean));
  for (const s of scenes) {
    inputFiles.add(s.audio.source);
    if (s.video) inputFiles.add(s.video.source);
    if (s.still) inputFiles.add(s.still.source);
    if (s.previousClip) inputFiles.add(s.previousClip.path);
  }
  const inputHashes = Object.fromEntries([...inputFiles].map((f) => [f, { sha256: sha256File(f), bytes: fs.statSync(f).size, mtimeMs: fs.statSync(f).mtimeMs }]));
  for (const f of inputFiles) {
    if (f === out || f.startsWith(out + path.sep)) throw new InputError(`input ${f} lies inside --out`);
  }

  if (options.dryRun) {
    return { dryRun: true, plan: { totalFrames: plan.totalFrames, seconds: plan.totalFrames / FPS, scenes: scenes.map(publicScene) } };
  }

  // Let a pending SIGINT/SIGTERM run before anything is created.
  await new Promise((resolve) => setImmediate(resolve));
  throwIfAborted();
  fs.mkdirSync(out); // throws EEXIST if another process got there first
  activeRun.out = out;
  activeRun.published = false;
  const work = path.join(out, "work");
  fs.mkdirSync(work);
  let verification = null;
  try {
    // --- audio: one master, one static gain --------------------------------
    const master = assembleNarration(plan);
    const prenorm = path.join(work, "narration-prenorm.wav");
    writeFloatWav(prenorm, [master, master], plan.sampleRate);
    const before = await measureLoudness(ffmpeg, prenorm);
    const loudnessGain = opts.targetLufs - before.integratedLufs;
    const peakGain = opts.maxTruePeakDbtp - opts.truePeakHeadroomDb - before.truePeakDbtp;
    const gainDb = Math.min(loudnessGain, peakGain);
    const gain = dbToAmp(gainDb);
    const final = Float32Array.from(master, (x) => x * gain);
    const wavName = path.join("work", "narration-master.wav");
    writeFloatWav(path.join(out, wavName), [final, final], plan.sampleRate);
    const perScene = [];
    for (const s of scenes) {
      const a = s.timeline.startSample;
      const b = a + s.timeline.samples;
      try {
        perScene.push({ index: s.index, ...(await measureLoudness(ffmpeg, path.join(out, wavName), `atrim=start_sample=${a}:end_sample=${b}`)) });
      } catch (error) {
        if (error instanceof AbortedError) throw error;
        perScene.push({ index: s.index, integratedLufs: null, truePeakDbtp: null });
      }
    }

    // --- captions ------------------------------------------------------------
    const captions = captionFiles(plan);
    fs.writeFileSync(path.join(out, "captions.ass"), captions.ass, { flag: "wx" });
    fs.writeFileSync(path.join(out, "captions.srt"), captions.srt, { flag: "wx" });

    // --- the single encode, into an unpublished name ----------------------------
    const args = encodeArgs(plan, { assName: "captions.ass", wavName, outputName: PARTIAL_NAME });
    log(`encoding ${plan.totalFrames} frames (${round(plan.totalFrames / FPS, 3)}s) into ${PARTIAL_NAME}…`);
    await runFfmpeg(ffmpeg, args, { cwd: out });
    const partial = path.join(out, PARTIAL_NAME);

    // --- verification on the actual (still unpublished) output -------------------
    const p = await probe(ffmpeg, partial);
    const st = await frameStats(ffmpeg, partial);
    const decoded = await decodeMono(ffmpeg, partial);
    const audioSeconds = decoded.samples.length / decoded.sampleRate;
    const videoSeconds = st.frames / FPS;
    const after = await measureLoudness(ffmpeg, partial);
    const checks = [];
    const check = (name, passed, detail, hard = true) => checks.push({ name, passed: Boolean(passed), hard, detail });
    check("output fps is 24", p.video?.fps === FPS && Math.abs((st.fpsFromTimestamps ?? 0) - FPS) < 0.01, { probedFps: p.video?.fps, fromTimestamps: st.fpsFromTimestamps });
    check("timestamps step uniformly", st.uniformStepSeconds !== null, { stepSeconds: st.uniformStepSeconds });
    check("output size", p.video?.width === plan.width && p.video?.height === plan.height, { width: p.video?.width, height: p.video?.height });
    check("frame count equals plan", st.frames === plan.totalFrames, { planned: plan.totalFrames, measured: st.frames });
    check("audio/video length within one frame", Math.abs(audioSeconds - videoSeconds) <= 1 / FPS, { audioSeconds: round(audioSeconds, 5), videoSeconds: round(videoSeconds, 5) });
    for (const s of scenes) {
      const run = longestIdenticalRun(st.md5, s.timeline.startFrame, s.timeline.startFrame + s.timeline.frames);
      s.output = { longestIdenticalFrameRun: run, tailIdenticalFrameRun: tailRun(st.md5.slice(s.timeline.startFrame, s.timeline.startFrame + s.timeline.frames), s.timeline.frames) };
      if (s.kind === "photo-pan") {
        check(`scene ${s.index} pan changes every frame`, run <= 1, { longestIdenticalFrameRun: run }, false);
      } else {
        check(`scene ${s.index} no repeated-frame run > 2 (source had ${s.video.sourceLongestIdenticalRun})`, run <= Math.max(2, s.video.sourceLongestIdenticalRun), { longestIdenticalFrameRun: run }, false);
      }
      if (s.silenceAcrossCutBeforeSeconds !== undefined) {
        check(`silence across cut into scene ${s.index} <= 0.6s`, s.silenceAcrossCutBeforeSeconds <= 0.6, { seconds: s.silenceAcrossCutBeforeSeconds }, false);
      }
    }
    check("master loudness -16 LUFS ±1 (or peak-limited)", Math.abs(after.integratedLufs - opts.targetLufs) <= 1 || peakGain < loudnessGain, after, false);
    check("true peak <= -1.5 dBTP", after.truePeakDbtp <= opts.maxTruePeakDbtp, after, false);
    const unchanged = [...inputFiles].every((f) => sha256File(f) === inputHashes[f].sha256 && fs.statSync(f).mtimeMs === inputHashes[f].mtimeMs);
    check("all inputs byte-identical afterwards", unchanged, { files: inputFiles.size });

    const hardFailed = checks.filter((c) => c.hard && !c.passed);
    const softFailed = checks.filter((c) => !c.hard && !c.passed);
    const passed = hardFailed.length === 0;
    verification = {
      passed,
      meaning: "passed = every HARD check passed; soft checks are warnings and are listed in softFailed",
      hardChecks: checks.filter((c) => c.hard).length,
      softChecks: checks.filter((c) => !c.hard).length,
      softWarnings: softFailed.length,
      softFailed: softFailed.map((c) => c.name),
      checks,
    };
    if (!passed) throw new Error(`verification failed: ${JSON.stringify(hardFailed)}`);

    const result = {
      tool: TOOL,
      createdAt: new Date().toISOString(),
      fps: FPS,
      width: plan.width,
      height: plan.height,
      projectId: plan.manifest.projectId ?? null,
      inputs: inputHashes,
      settings: opts,
      lipSync: {
        fixed: false,
        statement:
          "This local recut cannot repair lip sync. Presenter mouth movement in the existing clips was generated " +
          "without the narration recording; cutting, re-timing or re-encoding does not change it. Every presenter " +
          "scene is marked lipSyncFixed:false. Repair needs lip-sync processing or voice-over re-renders.",
      },
      audio: {
        sampleRate: plan.sampleRate,
        channels: 2,
        processing: "exact decoded narration samples; trailing silence after speech end + margin omitted; " +
          `${opts.fadeInMs}ms/${opts.fadeOutMs}ms edge fades per scene; one static master gain; one AAC encode; no resampling`,
        loudnessBefore: before,
        gainDb: round(gainDb, 3),
        gainLimitedBy: peakGain < loudnessGain ? "true-peak" : "loudness-target",
        loudnessAfterEncode: after,
        perScene,
      },
      captions: {
        timing: "approximate phrase timing: character-weighted over measured voiced regions, snapped to measured pauses; not forced alignment",
        files: ["captions.ass", "captions.srt"],
      },
      scenes: scenes.map(publicScene),
      output: {
        file: opts.outputName,
        encodedAs: PARTIAL_NAME,
        publishedOnlyAfter: "all hard verification checks passed and this manifest was written",
        sha256: sha256File(partial),
        bytes: fs.statSync(partial).size,
        measured: { videoFrames: st.frames, videoSeconds: round(videoSeconds, 5), audioSeconds: round(audioSeconds, 5), fps: p.video?.fps },
      },
      ffmpeg: { binary: ffmpeg, encodeArgs: args, cwd: "<out>" },
      verification,
    };

    // --- publish: success manifest first, then reel.mp4 as the final step -------
    throwIfAborted();
    fs.writeFileSync(path.join(out, "rebuild-manifest.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    throwIfAborted();
    const reel = path.join(out, opts.outputName);
    fs.linkSync(partial, reel); // EEXIST rather than ever replacing a file
    fs.unlinkSync(partial);
    activeRun.published = true;
    fs.rmSync(prenorm);
    return result;
  } catch (error) {
    if (activeRun.published) throw error;
    // An interrupted run is recorded by the signal handler once its children are dead.
    if (!(error instanceof AbortedError) && !abortState) {
      writeFailureMarker(out, { error: String(error?.message ?? error), signal: null, ...(verification ? { verification } : {}) });
      activeRun.out = null; // already recorded; a later signal must not rewrite it
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: "string" },
      "raw-sources": { type: "string" },
      stills: { type: "string" },
      "audio-assets": { type: "string" },
      headings: { type: "string" },
      out: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      "tail-margin": { type: "string" },
      "min-tail-margin": { type: "string" },
      "pan-zoom-end": { type: "string" },
      "pan-oversample": { type: "string" },
      "trim-eof-transient": { type: "boolean" },
      ffmpeg: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new InputError(`--${name} must be a positive number`);
    return n;
  };
  const tuning = Object.fromEntries(
    Object.entries({
      width: num(values.width, "width"),
      height: num(values.height, "height"),
      tailMarginSeconds: num(values["tail-margin"], "tail-margin"),
      minTailMarginSeconds: num(values["min-tail-margin"], "min-tail-margin"),
      panZoomEnd: num(values["pan-zoom-end"], "pan-zoom-end"),
      panOversample: num(values["pan-oversample"], "pan-oversample"),
      trimEofTransient: values["trim-eof-transient"] ? true : undefined,
    }).filter(([, v]) => v !== undefined),
  );
  if (tuning.minTailMarginSeconds !== undefined && tuning.minTailMarginSeconds > (tuning.tailMarginSeconds ?? DEFAULTS.tailMarginSeconds)) {
    throw new InputError("--min-tail-margin cannot exceed --tail-margin");
  }
  return {
    help: values.help,
    manifest: values.manifest,
    rawSources: values["raw-sources"],
    stills: values.stills,
    audioAssets: values["audio-assets"],
    headings: values.headings,
    out: values.out,
    ffmpeg: values.ffmpeg,
    dryRun: values["dry-run"] ?? false,
    tuning,
  };
}

/**
 * SIGINT/SIGTERM/SIGHUP: kill every running ffmpeg (SIGKILL), wait for them to
 * exit, leave FAILED.json in an unpublished output directory, exit 128+signal.
 * Every ffmpeg is spawned asynchronously, so this runs promptly in any phase.
 * On any process exit, still-running children are killed synchronously.
 */
function installSignalHandlers() {
  let handling = false;
  const onSignal = async (signal) => {
    if (handling) return;
    handling = true;
    process.stderr.write(`rebuild-reel: received ${signal}; stopping ffmpeg, nothing will be published\n`);
    await abortChildren(signal);
    try {
      if (markRunInterrupted(signal)) process.stderr.write(`rebuild-reel: wrote FAILED.json (no reel.mp4 published)\n`);
    } catch (error) {
      process.stderr.write(`rebuild-reel: could not write failure marker: ${error.message}\n`);
    }
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
  process.on("exit", killChildrenNow);
}

/** One honest summary line: hard result and soft warnings are reported separately. */
export function summaryLines(outFile, result) {
  const v = result.verification;
  const head = `rebuild-reel: wrote ${outFile} (${result.output.measured.videoFrames} frames @ ${FPS}fps)`;
  if (v.softWarnings === 0) {
    return { stdout: `${head}; all ${v.hardChecks + v.softChecks} hard and soft checks passed\n`, stderr: "" };
  }
  return {
    stdout: `${head}; all ${v.hardChecks} hard checks passed; ${v.softWarnings} soft check(s) FAILED — see warnings and rebuild-manifest.json\n`,
    stderr: v.softFailed.map((name) => `rebuild-reel: WARNING: soft check failed: ${name}\n`).join(""),
  };
}

function helpHeaderEnd() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  return lines.indexOf(" */") + 1;
}

async function main() {
  installSignalHandlers();
  let options;
  try {
    options = cliOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rebuild-reel: ${error.message}\n`);
    process.exit(2);
  }
  if (options.help || !options.manifest) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, helpHeaderEnd()).join("\n") + "\n");
    process.exit(options.help ? 0 : 2);
  }
  try {
    const result = await rebuild(options, (line) => process.stderr.write(`rebuild-reel: ${line}\n`));
    if (result.dryRun) process.stdout.write(JSON.stringify(result.plan, null, 2) + "\n");
    else {
      const lines = summaryLines(path.join(path.resolve(options.out), result.output.file), result);
      process.stderr.write(lines.stderr);
      process.stdout.write(lines.stdout);
    }
  } catch (error) {
    // An interrupted run exits from the signal handler, after its children are dead.
    if (error instanceof AbortedError || abortState) return;
    process.stderr.write(`rebuild-reel: ${error.message}\n`);
    process.exit(error instanceof InputError ? 3 : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
