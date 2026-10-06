/**
 * Real-ffmpeg tests for scripts/rebuild-reel.mjs.
 *
 * Every fixture is synthesised here (testsrc2 video, generated tone "speech",
 * generated stills) in a fresh temp directory. No model or network calls.
 * Run: npm run test:rebuild-reel
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "rebuild-reel.mjs");
const W = 180;
const H = 320;
const SR = 44100;

globalThis.fetch = async () => {
  throw new Error("network forbidden in rebuild-reel tests");
};

function ff(args) {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
  return result;
}

/** Tone "speech": voiced spans are a syllable-modulated chord, pauses are digital silence. */
function writeNarration(file, parts) {
  const samples = [];
  for (const part of parts) {
    const n = Math.round(part.seconds * SR);
    for (let i = 0; i < n; i += 1) {
      if (part.type === "silence") {
        samples.push(0);
        continue;
      }
      if (part.type === "ramp") {
        // A sound rising to `amplitude` and cut off by the end of the file.
        samples.push((part.amplitude * i) / n * Math.sin((2 * Math.PI * 900 * i) / SR));
        continue;
      }
      const t = i / SR;
      const syllable = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * 4 * t));
      const edge = Math.min(1, t / 0.01, (part.seconds - t) / 0.01);
      const amp = part.amplitude ?? 0.5;
      samples.push(amp * edge * syllable * (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t)));
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const wav = `${file}.wav`;
  fs.writeFileSync(wav, Buffer.concat([header, data]));
  ff(["-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", String(SR), "-ac", "1", file]);
  fs.rmSync(wav);
}

function writeClip(file, seconds, { fps = 24, width = W, height = H } = {}) {
  ff([
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}`,
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
    "-pix_fmt", "yuv420p", file,
  ]);
}

function writeStill(file, width, height) {
  ff(["-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1`, "-frames:v", "1", file]);
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const SPEECH_A = [
  { type: "silence", seconds: 0.1 },
  { type: "voice", seconds: 1.0 },
  { type: "silence", seconds: 0.3 },
  { type: "voice", seconds: 0.9 },
  { type: "silence", seconds: 0.9 },
]; // speech ends ~2.30s, file ~3.20s
const SPEECH_QUIET_TAIL = [
  { type: "silence", seconds: 0.05 },
  { type: "voice", seconds: 1.2 },
  { type: "silence", seconds: 0.5 },
  { type: "voice", seconds: 0.6, amplitude: 0.02 }, // ~ -36 dBFS: quiet but voiced
  { type: "silence", seconds: 0.7 },
]; // voiced content ends ~2.35s
const SPEECH_PAN = [
  { type: "silence", seconds: 0.08 },
  { type: "voice", seconds: 1.5 },
  { type: "silence", seconds: 0.6 },
];

/**
 * A three-scene project: two presenter scenes with retained raw motion, one
 * photo cutaway. `overrides` lets each test break one thing.
 */
const created = [];
test.after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixture(name, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rebuild-reel-${name}-`));
  created.push(dir);
  const media = path.join(dir, "media");
  fs.mkdirSync(media);
  const p = (f) => path.join(media, f);

  writeNarration(p("01.mp3"), overrides.speech1 ?? SPEECH_A);
  writeNarration(p("02.mp3"), overrides.speech2 ?? SPEECH_QUIET_TAIL);
  writeNarration(p("03.mp3"), SPEECH_PAN);
  writeClip(p("raw-1.mp4"), overrides.raw1Seconds ?? 3.0, overrides.raw1 ?? {});
  writeClip(p("raw-2.mp4"), 3.5);
  // The trimmed/muxed "final" clips the old exporter used: deliberately short.
  writeClip(p("final-1.mp4"), 2.0);
  writeClip(p("final-2.mp4"), 2.0);
  writeClip(p("cutaway-3-30fps.mp4"), 2.5, { fps: 30 });
  writeStill(p("still-1.png"), W, H);
  writeStill(p("still-2.png"), W, H);
  const [sw, sh] = overrides.still3 ?? [W, H];
  writeStill(p("still-3.png"), sw, sh);

  const manifest = {
    projectId: "prj_test",
    scenes: [
      { sceneId: "scn_1", videoAssetId: "ast_v1", video: p("final-1.mp4"), audio: p("01.mp3"), duration: 3.65, caption: "One day here? Start by getting a little lost in the old town." },
      { sceneId: "scn_2", videoAssetId: "ast_v2", video: p("final-2.mp4"), audio: p("02.mp3"), duration: 3.5, caption: "Follow the waterfront. This is a place to slow down." },
      { sceneId: "scn_3", videoAssetId: "ast_v3", video: p("cutaway-3-30fps.mp4"), audio: p("03.mp3"), duration: 2.65, caption: "Walk toward the lighthouse, then turn around." },
    ],
  };
  const raw = [
    { scene: 1, videoAssetId: "ast_v1", rawMotionPath: p("raw-1.mp4"), exists: true, audioMode: "mux", voiceAssetId: "ast_a1" },
    { scene: 2, videoAssetId: "ast_v2", rawMotionPath: p("raw-2.mp4"), exists: true, audioMode: "mux", voiceAssetId: "ast_a2" },
    { scene: 3, videoAssetId: "ast_v3", rawMotionPath: null, exists: false, audioMode: "mux", voiceAssetId: "ast_a3" },
  ];
  const stills = [
    { sceneId: "scn_1", assetId: "ast_i1", localPath: p("still-1.png"), meta: { provider: "kie", aspectRatio: "9:16" } },
    { sceneId: "scn_2", assetId: "ast_i2", localPath: p("still-2.png"), meta: { provider: "kie", aspectRatio: "9:16" } },
    { sceneId: "scn_3", assetId: "ast_i3", localPath: p("still-3.png"), meta: { provider: "licensed-source-photo", aspectRatio: "9:16" } },
  ];
  const audioAssets = [
    { sceneId: "scn_1", assetId: overrides.audioAsset1 ?? "ast_a1", file: p("01.mp3") },
    { sceneId: "scn_2", assetId: "ast_a2", file: p("02.mp3") },
    { sceneId: "scn_3", assetId: "ast_a3", file: p("03.mp3") },
  ];
  overrides.mutate?.({ manifest, raw, stills, audioAssets, p });
  const write = (f, v) => {
    const file = path.join(dir, f);
    fs.writeFileSync(file, JSON.stringify(v, null, 2));
    return file;
  };
  const files = {
    manifest: write("render-manifest.json", manifest),
    raw: write("raw-sources.json", raw),
    stills: write("stills.json", stills),
    audio: write("audio-assets.json", audioAssets),
    headings: write("headings.json", overrides.headings ?? ["TEST TOWN\n1. OLD TOWN", "2. HARBOUR", "3. LIGHTHOUSE"]),
  };
  const inputs = fs.readdirSync(media).map((f) => path.join(media, f)).concat(Object.values(files));
  return { dir, media, files, inputs, out: path.join(dir, "out") };
}

function cliArgs(fx, extra = [], { audio = true, ffmpeg = null } = {}) {
  return [
    CLI,
    "--manifest", fx.files.manifest,
    "--raw-sources", fx.files.raw,
    "--stills", fx.files.stills,
    ...(audio ? ["--audio-assets", fx.files.audio] : []),
    "--headings", fx.files.headings,
    "--out", fx.out,
    "--width", String(W),
    "--height", String(H),
    ...(ffmpeg ? ["--ffmpeg", ffmpeg] : []),
    ...extra,
  ];
}

function runCli(fx, extra = [], opts = {}) {
  return spawnSync(process.execPath, cliArgs(fx, extra, opts), { encoding: "utf8", timeout: 300_000 });
}

function snapshot(files) {
  return Object.fromEntries(files.map((f) => [f, { sha: sha(f), mtimeMs: fs.statSync(f).mtimeMs }]));
}

/** Grey frames, downscaled, as Uint8Array per frame. */
function greyFrames(file, gw = 90, gh = 160) {
  const result = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-vf", `scale=${gw}:${gh}:flags=area,format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, String(result.stderr));
  const size = gw * gh;
  const frames = [];
  for (let o = 0; o + size <= result.stdout.length; o += size) frames.push(result.stdout.subarray(o, o + size));
  return frames;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function probe(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8" });
  return r.stderr;
}

function decodeAudioSamples(file) {
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  assert.equal(r.status, 0, String(r.stderr));
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
}

// ---------------------------------------------------------------------------

test("source of the exporter never pads or clones frames, or time-stretches audio", () => {
  const source = fs.readFileSync(CLI, "utf8");
  assert.doesNotMatch(source, /tpad|stop_mode|clone/i, "no frame cloning");
  assert.doesNotMatch(source, /atempo|rubberband|asetrate|minterpolate/i, "no stretching / interpolation");
  assert.doesNotMatch(source, /\/home\/|\.local\/share|\/Users\//, "no private absolute paths");
});

test("refuses to overwrite an existing output directory", () => {
  const fx = makeFixture("overwrite");
  fs.mkdirSync(fx.out);
  fs.writeFileSync(path.join(fx.out, "keep.txt"), "do not touch");
  const before = snapshot(fx.inputs);
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/i);
  assert.deepEqual(fs.readdirSync(fx.out), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(fx.out, "keep.txt"), "utf8"), "do not touch");
  assert.deepEqual(snapshot(fx.inputs), before);
});

test("rejects a raw clip too short for the speech instead of freezing it", () => {
  const fx = makeFixture("short", { raw1Seconds: 2.0 });
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /scene 1/i);
  assert.match(r.stderr, /insufficient motion|too short/i);
  assert.equal(fs.existsSync(fx.out), false, "nothing written on a rejected input");
});

test("rejects a non-24fps presenter source rather than converting it", () => {
  const fx = makeFixture("fps", { raw1: { fps: 30 }, raw1Seconds: 3.0 });
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /24 ?fps/i);
  assert.equal(fs.existsSync(fx.out), false);
});

test("refuses a still whose aspect ratio would need a destructive crop", () => {
  const fx = makeFixture("landscape", { still3: [320, 180] });
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /aspect/i);
  assert.equal(fs.existsSync(fx.out), false);
});

test("full rebuild: 24fps, no freeze tails, safe trims, originals preserved", () => {
  const fx = makeFixture("full", { still3: [240, 240] }); // square still: safe centre-crop
  const before = snapshot(fx.inputs);
  const r = runCli(fx);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(fx.inputs), before, "inputs byte-identical with unchanged mtimes");

  const m = JSON.parse(fs.readFileSync(path.join(fx.out, "rebuild-manifest.json"), "utf8"));
  const reel = path.join(fx.out, m.output.file);
  assert.ok(fs.existsSync(reel));
  assert.equal(m.fps, 24);
  assert.equal(m.scenes.length, 3);

  // --- manifest honesty ---
  const [s1, s2, s3] = m.scenes;
  assert.equal(s1.kind, "presenter-raw-motion");
  assert.equal(s2.kind, "presenter-raw-motion");
  assert.equal(s3.kind, "photo-pan");
  for (const s of [s1, s2]) {
    assert.equal(s.lipSyncFixed, false);
    assert.equal(s.video.source, path.resolve(s === s1 ? fx.media + "/raw-1.mp4" : fx.media + "/raw-2.mp4"));
    assert.equal(s.video.sourceFps, 24);
    assert.ok(s.video.framesUsed <= s.video.sourceFrames);
  }
  assert.equal(s1.voiceAssetId, "ast_a1");
  assert.equal(s3.still.aspect.action, "center-crop");
  assert.ok(s3.still.aspect.keptFraction > 0.5 && s3.still.aspect.keptFraction < 0.6);
  assert.match(m.lipSync.statement, /cannot repair/i);
  assert.match(m.captions.timing, /not forced alignment/i);

  // --- silence-trim safety ---
  // Scene 1: speech ends ~2.30s; only verified trailing silence may go.
  assert.ok(s1.audio.speechEndSeconds > 2.25 && s1.audio.speechEndSeconds < 2.36, `speech end ${s1.audio.speechEndSeconds}`);
  assert.ok(s1.audio.keptSeconds >= s1.audio.speechEndSeconds + 0.12);
  assert.ok(s1.audio.trimmedTrailingSeconds > 0.3);
  assert.ok(s1.audio.trimmedRegionPeakDbfs < -40, "trimmed region is silence");
  // Scene 2: the quiet (~-36 dBFS) phrase after the pause is voice, and is kept.
  assert.ok(s2.audio.speechEndSeconds > 2.3, `quiet tail kept: ${s2.audio.speechEndSeconds}`);
  assert.ok(s2.audio.keptSeconds >= 2.35 + 0.12);

  // --- 24fps, exact frame and sample accounting ---
  const info = probe(reel);
  assert.match(info, /\b24 fps\b/);
  assert.match(info, new RegExp(`${W}x${H}`));
  const frames = greyFrames(reel);
  const planned = m.scenes.reduce((n, s) => n + s.timeline.frames, 0);
  assert.equal(frames.length, planned, "frame count equals planned frames");
  assert.equal(m.output.measured.videoFrames, planned);
  const audio = decodeAudioSamples(reel);
  const audioSeconds = audio.length / SR;
  assert.ok(Math.abs(audioSeconds - planned / 24) <= 1 / 24, `A/V ${audioSeconds} vs ${planned / 24}`);
  assert.ok(Math.abs(m.output.measured.audioSeconds - m.output.measured.videoSeconds) <= 1 / 24);

  // --- no cloned freeze tail; presenter frames are the source frames in order ---
  for (const s of [s1, s2]) {
    const start = s.timeline.startFrame;
    const end = start + s.timeline.frames;
    for (let f = start + 1; f < end; f += 1) {
      assert.ok(meanAbsDiff(frames[f], frames[f - 1]) > 0.5, `scene ${s.index} frame ${f - start} repeats`);
    }
    const src = greyFrames(s.video.source);
    for (const k of [0, Math.floor(s.timeline.frames / 2), s.timeline.frames - 1]) {
      const out = frames[start + k];
      const same = meanAbsDiff(out, src[k]);
      assert.ok(same < meanAbsDiff(out, src[k + 1]), `frame ${k} aligns with source frame ${k}`);
      if (k > 0) assert.ok(same < meanAbsDiff(out, src[k - 1]));
    }
  }
  // --- the pan moves on every frame (no stepped duplicates) ---
  for (let f = s3.timeline.startFrame + 1; f < s3.timeline.startFrame + s3.timeline.frames; f += 1) {
    assert.ok(meanAbsDiff(frames[f], frames[f - 1]) > 0, `pan frame ${f} identical to previous`);
  }
  assert.equal(m.verification.passed, true, JSON.stringify(m.verification));

  // --- the quiet tail of scene 2 is audible in the output at its planned time ---
  const t0 = s2.timeline.startSeconds + 1.80;
  const t1 = s2.timeline.startSeconds + 2.30;
  let peak = 0;
  for (let i = Math.floor(t0 * SR); i < Math.floor(t1 * SR); i += 1) peak = Math.max(peak, Math.abs(audio[i]));
  assert.ok(peak > 0.002, `quiet voiced tail present in output (peak ${peak})`);

  // --- captions sit inside each scene's edited window ---
  for (const s of m.scenes) {
    for (const c of s.captions) {
      assert.ok(c.start >= s.timeline.startSeconds - 1e-6 && c.end <= s.timeline.startSeconds + s.timeline.seconds + 1e-6);
      assert.ok(c.end > c.start);
    }
  }
  assert.ok(fs.existsSync(path.join(fx.out, "captions.srt")));

  // --- a second run into the same directory is refused ---
  const again = runCli(fx);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/i);
});

test("uses only real motion when the raw clip sits between the minimum and preferred margin", () => {
  // speech ends ~2.30s: minimum 2.42s (59 frames), preferred 2.60s (63 frames); raw has 60.
  const fx = makeFixture("between", { raw1Seconds: 2.5 });
  const r = runCli(fx);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(fx.out, "rebuild-manifest.json"), "utf8"));
  const s1 = m.scenes[0];
  assert.equal(s1.video.sourceFrames, 60);
  assert.equal(s1.timeline.frames, 60, "every real frame, none invented");
  assert.equal(s1.video.framesUnused, 0);
  assert.ok(s1.audio.marginAfterSpeechSeconds >= 0.12 - 1e-6);
  assert.ok(s1.audio.marginAfterSpeechSeconds < 0.3);
});

test("speech running to the end of the file is never trimmed", () => {
  const fx = makeFixture("noTail", {
    speech1: [
      { type: "silence", seconds: 0.1 },
      { type: "voice", seconds: 2.0 },
    ],
  });
  const r = runCli(fx);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(fx.out, "rebuild-manifest.json"), "utf8"));
  const a = m.scenes[0].audio;
  assert.equal(a.trimmedTrailingSeconds, 0);
  assert.equal(a.keptSamples, a.sourceSamples, "whole take kept");
  assert.ok(a.paddedSilenceSeconds < 1 / 24, "at most one frame of padding to the frame grid");
});

test("refuses a narration that is not the selected voice asset", () => {
  const fx = makeFixture("voiceId", { audioAsset1: "ast_some_other_take" });
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /voice asset/i);
  assert.equal(fs.existsSync(fx.out), false);
});

test("refuses headings that do not match the scene count", () => {
  const fx = makeFixture("headings", { headings: ["only one"] });
  const r = runCli(fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /headings/i);
  assert.equal(fs.existsSync(fx.out), false);
});

test("--dry-run validates and plans but writes nothing", () => {
  const fx = makeFixture("dry");
  const before = snapshot(fx.inputs);
  const r = runCli(fx, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.scenes.length, 3);
  assert.equal(fs.existsSync(fx.out), false);
  assert.deepEqual(snapshot(fx.inputs), before);
});

test("an end-of-file transient is reported and kept by default, trimmed only on request", () => {
  const speech = [
    { type: "silence", seconds: 0.1 },
    { type: "voice", seconds: 1.6 },
    { type: "silence", seconds: 0.9 },
    { type: "ramp", seconds: 0.03, amplitude: 0.03 }, // ~ -30 dBFS, truncated by EOF
  ];
  const keep = makeFixture("eofKeep", { speech1: speech });
  let r = runCli(keep);
  assert.equal(r.status, 0, r.stderr);
  let a = JSON.parse(fs.readFileSync(path.join(keep.out, "rebuild-manifest.json"), "utf8")).scenes[0].audio;
  assert.ok(a.eofTransient, "transient detected and reported");
  assert.equal(a.eofTransient.trimmed, false);
  assert.equal(a.trimmedTrailingSeconds, 0, "not provably silence, so kept by default");
  assert.ok(a.sustainedSpeechEndSeconds < 1.8, "sustained speech end reported separately");

  const trim = makeFixture("eofTrim", { speech1: speech });
  r = runCli(trim, ["--trim-eof-transient"]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(trim.out, "rebuild-manifest.json"), "utf8"));
  a = m.scenes[0].audio;
  assert.equal(a.eofTransient.trimmed, true);
  assert.ok(a.speechEndSeconds < 1.8);
  assert.ok(a.trimmedTrailingSeconds > 0.5);
  assert.ok(a.keptSeconds >= a.speechEndSeconds + 0.12);
  assert.equal(m.settings.trimEofTransient, true, "choice recorded");
});

// ---------------------------------------------------------------------------
// B1: strict input identity / provenance. No positional fallback.
// ---------------------------------------------------------------------------

function assertRefused(fx, r, pattern) {
  assert.equal(r.status, 3, `expected input refusal (exit 3), got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, pattern);
  assert.equal(fs.existsSync(fx.out), false, "nothing written on a refused input");
}

test("B1-A refuses a manifest videoAssetId that raw-sources does not have (no positional fallback)", () => {
  const fx = makeFixture("b1a", { mutate: ({ manifest }) => { manifest.scenes[1].videoAssetId = "ast_SOMETHING_ELSE"; } });
  assertRefused(fx, runCli(fx), /ast_SOMETHING_ELSE/);
});

test("B1-B refuses manifest scenes without a videoAssetId", () => {
  const fx = makeFixture("b1b", { mutate: ({ manifest }) => { for (const s of manifest.scenes) delete s.videoAssetId; } });
  assertRefused(fx, runCli(fx), /videoAssetId/);
});

test("B1-C refuses a manifest order that contradicts raw-sources scene numbers", () => {
  const fx = makeFixture("b1c", { mutate: ({ manifest }) => { manifest.scenes.reverse(); } });
  assertRefused(fx, runCli(fx), /scene number|position|order/i);
});

test("B1-F refuses a raw-sources entry whose videoAssetId contradicts the manifest", () => {
  const fx = makeFixture("b1f", { mutate: ({ raw }) => { raw[0].videoAssetId = "ast_OTHER"; } });
  assertRefused(fx, runCli(fx), /ast_OTHER|videoAssetId/);
});

test("B1-G --audio-assets is required; voice provenance is never recorded without it", () => {
  const swapped = makeFixture("b1g", { mutate: ({ manifest, p }) => { manifest.scenes[0].audio = p("02.mp3"); } });
  assertRefused(swapped, runCli(swapped, [], { audio: false }), /--audio-assets/);
  const valid = makeFixture("b1g0");
  assertRefused(valid, runCli(valid, [], { audio: false }), /--audio-assets/);
  // With the map supplied, the wrong narration file is caught.
  const checked = makeFixture("b1g2", { mutate: ({ manifest, p }) => { manifest.scenes[0].audio = p("02.mp3"); } });
  assertRefused(checked, runCli(checked), /narration|audio/i);
});

test("B1-H refuses a manifest that lists the same scene twice", () => {
  const fx = makeFixture("b1h", { mutate: ({ manifest }) => { manifest.scenes[1] = { ...manifest.scenes[0] }; } });
  assertRefused(fx, runCli(fx), /duplicate/i);
});

test("B1 refuses count / uniqueness / contradiction errors in the lookup maps", () => {
  const cases = [
    ["raw-missing", ({ raw }) => { raw.pop(); }, /raw-sources/],
    ["raw-extra", ({ raw, p }) => { raw.push({ scene: 4, videoAssetId: "ast_v4", rawMotionPath: p("raw-2.mp4") }); }, /raw-sources/],
    ["raw-dup-scene", ({ raw }) => { raw[1].scene = 1; }, /duplicate|scene/i],
    ["raw-dup-path", ({ raw }) => { raw[1].rawMotionPath = raw[0].rawMotionPath; }, /duplicate|rawMotionPath/i],
    ["stills-missing", ({ stills }) => { stills.pop(); }, /--stills/],
    ["stills-dup", ({ stills }) => { stills[1].sceneId = "scn_1"; }, /duplicate|--stills/i],
    ["audio-missing", ({ audioAssets }) => { audioAssets.pop(); }, /--audio-assets/],
    ["audio-dup-asset", ({ audioAssets }) => { audioAssets[1].assetId = "ast_a1"; }, /duplicate|--audio-assets/i],
    ["audio-wrong-scene", ({ audioAssets }) => { audioAssets[0].sceneId = "scn_x"; }, /--audio-assets|scn_x/],
    ["voice-contradiction", ({ raw }) => { raw[1].voiceAssetId = "ast_a_other"; }, /voice asset/i],
  ];
  for (const [name, mutate, pattern] of cases) {
    const fx = makeFixture(`b1-${name}`, { mutate });
    const r = runCli(fx, ["--dry-run"]);
    assert.equal(r.status, 3, `${name}: expected refusal, got ${r.status}\n${r.stdout.slice(0, 300)}\n${r.stderr}`);
    assert.match(r.stderr, pattern, name);
  }
});

test("B1 valid inputs with reordered lookup arrays map by exact ID, not position", () => {
  const fx = makeFixture("b1-reordered", {
    mutate: ({ raw, stills, audioAssets }) => {
      raw.reverse();
      stills.reverse();
      audioAssets.reverse();
    },
  });
  const r = runCli(fx, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  const [s1, s2, s3] = plan.scenes;
  assert.equal(s1.video.source, path.join(fx.media, "raw-1.mp4"));
  assert.equal(s2.video.source, path.join(fx.media, "raw-2.mp4"));
  assert.equal(s3.kind, "photo-pan");
  assert.equal(s3.still.source, path.join(fx.media, "still-3.png"));
  assert.deepEqual(plan.scenes.map((s) => [s.sceneId, s.videoAssetId, s.voiceAssetId, s.stillAssetId]), [
    ["scn_1", "ast_v1", "ast_a1", "ast_i1"],
    ["scn_2", "ast_v2", "ast_a2", "ast_i2"],
    ["scn_3", "ast_v3", "ast_a3", "ast_i3"],
  ]);
  assert.ok(plan.scenes.every((s) => s.voiceAssetVerified === true), "voice provenance marked verified");
});

// ---------------------------------------------------------------------------
// B2: never leave an unverified reel.mp4.
// ---------------------------------------------------------------------------

function procTable() {
  const out = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(d), state: fields[0], ppid: Number(fields[1]), cmd: fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ") });
    } catch {
      // process went away
    }
  }
  return out;
}
const isAlive = (pid) => procTable().some((p) => p.pid === pid && p.state !== "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAS_PROC = fs.existsSync("/proc/self/stat");

/** A --ffmpeg wrapper that misbehaves only on the post-encode framemd5 of the reel. */
function ffmpegWrapper(fx, mode, pattern = "*/out/*reel*.mp4*framemd5*") {
  const file = path.join(fx.dir, `ffmpeg-${mode}.sh`);
  const mark = path.join(fx.dir, `${mode}.pid`);
  const action = mode === "stall"
    ? `echo $$ > '${mark}'; exec sleep 120`
    : `'${FFMPEG}' "$@" | sed '$d'; exit 0`; // drop one decoded frame -> hard check fails
  fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in\n  ${pattern}) ${action};;\nesac\nexec '${FFMPEG}' "$@"\n`, { mode: 0o755 });
  return { file, mark };
}

const LONG_SPEECH = [
  { type: "silence", seconds: 0.1 },
  { type: "voice", seconds: 5.5 },
  { type: "silence", seconds: 0.3 },
];

async function interruptRun(name, signal, phase) {
  const fx = makeFixture(name, { speech1: LONG_SPEECH, raw1Seconds: 6 });
  const wrapper = phase === "verify" ? ffmpegWrapper(fx, "stall")
    : phase === "plan" ? ffmpegWrapper(fx, "stall", "*/media/raw-1.mp4*framemd5*")
    : null;
  // Full-size output so the single encode runs long enough to be interrupted.
  const args = cliArgs(fx, ["--width", "1440", "--height", "2560"], { ffmpeg: wrapper?.file });
  const cli = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  cli.stderr.on("data", (d) => { stderr += d; });
  const closed = new Promise((resolve) => cli.on("close", (code, sig) => resolve({ code, sig })));
  let target = null;
  for (let i = 0; i < 2400 && !target; i += 1) {
    await sleep(50);
    if (phase === "encode") target = procTable().find((p) => p.ppid === cli.pid && p.cmd.includes("libx264"));
    else if (fs.existsSync(wrapper.mark) && fs.readFileSync(wrapper.mark, "utf8").trim()) target = { pid: Number(fs.readFileSync(wrapper.mark, "utf8")) };
  }
  assert.ok(target, `never reached the ${phase} phase\n${stderr}`);
  await sleep(phase === "encode" ? 500 : 200);
  assert.ok(isAlive(target.pid), "child still running when the signal is sent (genuinely mid-phase)");
  assert.equal(fs.existsSync(path.join(fx.out, "reel.mp4")), false);
  if (phase === "plan") assert.equal(fs.existsSync(fx.out), false, "planning has not created --out");
  cli.kill(signal);
  const { code } = await closed;
  return { fx, target, code, stderr };
}

function assertNothingPublished(fx, target) {
  assert.equal(isAlive(target.pid), false, `spawned child ${target.pid} survived the CLI`);
  const strays = procTable().filter((p) => p.state !== "Z" && p.cmd.includes(fx.dir));
  assert.deepEqual(strays.map((p) => p.cmd), [], "no process still references the fixture");
  assert.equal(fs.existsSync(path.join(fx.out, "reel.mp4")), false, "no reel.mp4 published");
  assert.equal(fs.existsSync(path.join(fx.out, "rebuild-manifest.json")), false, "no success manifest");
  assert.ok(fs.existsSync(path.join(fx.out, "FAILED.json")), "failure marker written");
  assert.ok(fs.existsSync(path.join(fx.out, "work", "narration-master.wav")), "debug intermediates preserved");
  return JSON.parse(fs.readFileSync(path.join(fx.out, "FAILED.json"), "utf8"));
}

for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`B2 ${signal} mid-encode kills ffmpeg, writes FAILED.json and publishes no reel.mp4`, { skip: !HAS_PROC, timeout: 240_000 }, async () => {
    const { fx, target, code, stderr } = await interruptRun(`b2-enc-${signal}`, signal, "encode");
    assert.equal(code, exitCode, stderr);
    const failed = assertNothingPublished(fx, target);
    assert.equal(failed.signal, signal);
    assert.equal(failed.published, false);
    await sleep(3000); // an orphaned encoder would have finished by now
    assert.equal(fs.existsSync(path.join(fx.out, "reel.mp4")), false, "still no reel.mp4 later");
    assert.equal(isAlive(target.pid), false);
  });
}

test("B2 SIGTERM during post-encode verification kills the verifier and publishes nothing", { skip: !HAS_PROC, timeout: 240_000 }, async () => {
  const { fx, target, code, stderr } = await interruptRun("b2-verify", "SIGTERM", "verify");
  assert.equal(code, 143, stderr);
  const failed = assertNothingPublished(fx, target);
  assert.equal(failed.signal, "SIGTERM");
  assert.ok(fs.existsSync(path.join(fx.out, "work", "reel.partial.mp4")), "unverified encode kept only under work/");
});

test("B2 SIGTERM while planning (read-only probe running) exits promptly and creates nothing", { skip: !HAS_PROC, timeout: 120_000 }, async () => {
  const t0 = Date.now();
  const { fx, target, code, stderr } = await interruptRun("b2-plan", "SIGTERM", "plan");
  assert.equal(code, 143, stderr);
  assert.ok(Date.now() - t0 < 60_000, "did not wait for the stalled 120s probe");
  assert.equal(isAlive(target.pid), false, "planning probe killed");
  assert.equal(fs.existsSync(fx.out), false, "no output directory created");
});

test("B2 a failed hard verification check publishes no reel.mp4", () => {
  const fx = makeFixture("b2-hardfail");
  const wrapper = ffmpegWrapper(fx, "dropframe");
  const r = runCli(fx, [], { ffmpeg: wrapper.file });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /verification failed/i);
  assert.match(r.stderr, /frame count equals plan/);
  assert.equal(fs.existsSync(path.join(fx.out, "reel.mp4")), false, "no reel.mp4 published");
  assert.equal(fs.existsSync(path.join(fx.out, "rebuild-manifest.json")), false, "no success manifest");
  const failed = JSON.parse(fs.readFileSync(path.join(fx.out, "FAILED.json"), "utf8"));
  assert.equal(failed.published, false);
  assert.ok(failed.verification.checks.some((c) => c.hard && !c.passed && c.name === "frame count equals plan"));
  assert.ok(fs.existsSync(path.join(fx.out, "work", "reel.partial.mp4")), "unverified encode kept only under work/");
});

test("B2 a successful run publishes reel.mp4 only with its success manifest", () => {
  const fx = makeFixture("b2-success");
  const r = runCli(fx);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(fx.out, "rebuild-manifest.json"), "utf8"));
  assert.equal(m.verification.passed, true);
  assert.equal(m.output.file, "reel.mp4");
  assert.equal(m.output.sha256, sha(path.join(fx.out, "reel.mp4")), "manifest hash is the published file");
  assert.equal(fs.existsSync(path.join(fx.out, "work", "reel.partial.mp4")), false);
  assert.equal(fs.existsSync(path.join(fx.out, "FAILED.json")), false);
  assert.ok(m.verification.checks.every((c) => c.passed), JSON.stringify(m.verification.checks.filter((c) => !c.passed)));
  assert.match(r.stdout, /all \d+ hard and soft checks passed/);
  assert.doesNotMatch(r.stderr, /WARNING/);
});

// ---------------------------------------------------------------------------
// N1: soft warnings are not reported as "verification passed".
// ---------------------------------------------------------------------------

test("N1 soft-check failures are printed as warnings, not as verification passed", () => {
  const fx = makeFixture("n1-soft", {
    speech2: [
      { type: "silence", seconds: 1.0 },
      { type: "voice", seconds: 1.2 },
      { type: "silence", seconds: 0.3 },
    ],
  });
  const r = runCli(fx);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(fx.out, "rebuild-manifest.json"), "utf8"));
  const soft = m.verification.checks.filter((c) => !c.hard && !c.passed);
  assert.ok(soft.some((c) => /silence across cut into scene 2/.test(c.name)), "fixture really fails a soft check");
  assert.equal(m.verification.passed, true, "hard checks passed");
  assert.equal(m.verification.softWarnings, soft.length);
  const all = r.stdout + r.stderr;
  assert.doesNotMatch(all, /verification passed/i, "no unconditional all-passed claim");
  assert.match(r.stdout, /hard checks passed/i);
  assert.match(r.stdout, /1 soft check\(s\) FAILED/);
  assert.match(r.stderr, /WARNING: soft check failed: silence across cut into scene 2/);
});
