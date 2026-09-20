import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * ffmpeg integration.
 *
 * Two jobs: laying a voice track onto a silent clip, and joining a project's
 * shots into the single video the operator asked for. The second is not a
 * convenience — a thirty-second brief that hands back four files has not
 * delivered a thirty-second video.
 *
 * Resolution order is `FFMPEG_PATH`, then the `ffmpeg-static` package, then
 * whatever is on PATH. The static package is a dependency now: the previous
 * position — that nothing should install a binary — was defensible while
 * ffmpeg only improved convenience, and stopped being defensible once the
 * finished deliverable depended on it. It is a prebuilt binary, not a
 * compile-on-install native module, so it does not bring back the install
 * fragility that argument was about.
 */

function resolveFfmpeg(): string {
  const explicit = process.env.FFMPEG_PATH?.trim();
  if (explicit) return explicit;
  try {
    // `createRequire`, not a bare `require`: this module is ESM, where `require`
    // is undefined — so the bare call threw, the catch swallowed it, and every
    // lookup fell through to a PATH binary that is not there. The symptom was a
    // final cut that reported "ffmpeg is unavailable" on a machine where the
    // package was installed and working.
    const resolve = createRequire(import.meta.url);
    const fromPackage = resolve("ffmpeg-static") as unknown as string | null;
    if (typeof fromPackage === "string" && fromPackage.length > 0) return fromPackage;
  } catch {
    // Not installed — fall through to PATH.
  }
  return "ffmpeg";
}

const FFMPEG = resolveFfmpeg();

let detection: Promise<boolean> | null = null;

/** Is ffmpeg usable? Probed once per process; never throws. */
export function ffmpegAvailable(): Promise<boolean> {
  detection ??= new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG, ["-version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  return detection;
}

export interface MuxResult {
  outputPath: string;
  bytes: number;
}

/**
 * Combine a silent video and an audio track into one MP4.
 *
 * The video stream is copied rather than re-encoded — it is already H.264 from
 * the provider, and a re-encode would cost quality and minutes for no gain.
 * Only the audio is transcoded, to AAC, which is what MP4 players expect.
 *
 * `-shortest` ends the output with whichever input runs out first. That is safe
 * here *because* the clip was commissioned at the measured length of this exact
 * audio; if the two ever drift apart, the caller is the one that knows by how
 * much and should say so rather than letting this silently trim.
 */
export async function muxAudioOntoVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<MuxResult> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-y",
        "-loglevel", "error",
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the tail only; ffmpeg can be verbose and the end is the useful part.
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on("error", (cause) => reject(new Error(`Could not run ffmpeg: ${cause.message}`)));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
  });

  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}


/**
 * How much audible material after the last silence still counts as "the clip
 * ended here" rather than "the line continued".
 */
const AUDIBLE_TAIL_SECONDS = 0.35;

/**
 * Cut dead air off the end of a finished clip.
 *
 * Video models take a whole number of seconds, so a 7.13-second line is
 * commissioned as an 8-second clip and the model fills the remaining 0.87s with
 * a person who has stopped talking. Alone it reads as a beat. Joined into a
 * sequence it reads as a fault: the piece stalls at every cut, which is exactly
 * what a 15-second test came back with — 0.9s of silence at the end of one shot
 * and 1.1s at the end of the next.
 *
 * Measured rather than calculated, because the audio does not always come from
 * the file whose length we know: in lip-sync mode the video model re-performs
 * the line and its timing is its own. `silencedetect` reports where the sound
 * actually stops, whatever produced it.
 *
 * `keepSeconds` of room is left after the last sound — speech decays, and
 * cutting the instant it drops below the threshold clips the final consonant.
 *
 * Returns null when there is nothing to trim, ffmpeg is unavailable, or the
 * trailing gap is too small to be worth a re-mux; the caller keeps the original.
 */
export async function trimTrailingSilence(
  videoPath: string,
  outputPath: string,
  options: { thresholdDb?: number; minGapSeconds?: number; keepSeconds?: number } = {},
): Promise<MuxResult | null> {
  const { thresholdDb = -45, minGapSeconds = 0.35, keepSeconds = 0.18 } = options;
  if (!(await ffmpegAvailable())) return null;

  const probe = await runFfmpeg([
    "-i", videoPath,
    "-af", `silencedetect=noise=${thresholdDb}dB:d=0.25`,
    "-f", "null", "-",
  ]);
  if (probe === null) return null;

  const duration = lastMatch(probe, /Duration: (\d+):(\d+):([\d.]+)/, (m) =>
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
  );
  const starts = [...probe.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...probe.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  if (duration === null || starts.length === 0) return null;

  const lastStart = starts[starts.length - 1];

  /**
   * Is the last silence the trailing one, or a pause with more line to come?
   *
   * Answered from how much audible material follows it, which is the one thing
   * that actually separates the two: an end-of-clip gap is followed by nothing
   * or by a few frames of artefact, a mid-sentence breath by the rest of the
   * sentence. Getting this wrong in the trimming direction truncates the line,
   * so the bar is deliberately low — a third of a second of speech is enough to
   * call it a pause and leave the clip alone.
   *
   * Two simpler tests were tried and both failed on real output. "Did the
   * silence close?" refuses every real case, because ffmpeg closes the final
   * silence when the audio stream ends — one clip closed at 8.87s of a 9.10s
   * file with nothing after it but −66 dB. "Is the tail quiet?" fails the other
   * way: clips end on a click that peaks at −13 dB inside a stretch that is
   * silent to the ear and to silencedetect.
   */
  const lastEnd = ends.filter((end) => end > lastStart).pop() ?? duration;
  if (duration - lastEnd > AUDIBLE_TAIL_SECONDS) return null;

  const cutAt = Math.min(duration, lastStart + keepSeconds);
  if (duration - cutAt < minGapSeconds) return null;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const cut = await runFfmpeg([
    "-y",
    "-i", videoPath,
    "-t", cutAt.toFixed(3),
    /**
     * Both streams are re-encoded, and the video one matters.
     *
     * A stream copy can only cut on a keyframe, so asking it to end at an
     * arbitrary time leaves a partial group of pictures at the tail — frames
     * that reference a keyframe which is no longer in the file. The clip still
     * plays and still reports the right duration, but a decoder stumbles over
     * the end of it. Joined into a sequence that reads as a stutter at the cut,
     * and only at cuts where the outgoing shot was trimmed: reported as three
     * shots joining badly and the fourth, the one nothing was trimmed from,
     * joining cleanly.
     *
     * Re-encoding costs a few seconds per clip and makes the cut frame-accurate
     * with a clean GOP. CRF 18 is visually transparent at this scale, and the
     * frame rate is pinned so every joined clip shares a timebase.
     */
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath,
  ]);
  if (cut === null) return null;

  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}

/** Run ffmpeg and hand back its stderr, or null when it could not run. */
function runFfmpeg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-20000);
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? stderr : null));
  });
}

/**
 * The LAST match, which is what the name promised and not what it did.
 *
 * This called `pattern.exec` and returned the *first* match. For the patterns
 * it was written against that was invisible — a file has one `Duration:` line,
 * so first and last are the same match — and it stayed invisible until
 * something asked it for a progress timestamp.
 *
 * ffmpeg prints `time=` once per progress update, so reading the first one
 * reports how far the decode had got a fraction of a second in. That number
 * was being used as the length of a finished video: a 26.8-second cut measured
 * as 14.4, and the music mix then cropped the video to match, silently
 * throwing away half a finished three-scene render.
 */
/**
 * The part of ffmpeg's output that says what went wrong.
 *
 * ffmpeg opens every run with its version, its full `--enable-lib...`
 * configure line and eight library versions — well over a thousand characters
 * of banner before it has said anything about the job. A failed cut used to
 * put that banner straight into the job's error field, so the operator's
 * screen read `ffmpeg exited with 234: enable-libaom --enable-libfribidi …`
 * and the actual sentence — a codec that could not be read — was somewhere off
 * the end of it.
 *
 * Keeps the lines that are about this run and drops the boilerplate, newest
 * last, because ffmpeg states the real problem just before it gives up.
 */
function complaint(stderr: string): string {
  const noise =
    /^(ffmpeg version|built with|configuration:|\s*lib(avutil|avcodec|avformat|avdevice|avfilter|swscale|swresample|postproc)|\s*--enable|\s*Metadata:|\s*encoder\s*:|\s*handler_name|\s*vendor_id|\s*compatible_brands|\s*major_brand|\s*minor_version|\s*Duration:|\s*Stream mapping:|\s*Press \[q\])/;
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !noise.test(line));
  // The last few lines, which is where the reason for giving up is.
  return lines.slice(-4).join(" ").slice(0, 400).trim();
}

function lastMatch<T>(text: string, pattern: RegExp, map: (m: RegExpMatchArray) => T): T | null {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpMatchArray | null = null;
  for (const found of text.matchAll(all)) match = found;
  return match ? map(match) : null;
}

/**
 * Join clips, in order, into one file.
 *
 * Uses the concat demuxer with `-c copy`: every clip comes from the same model
 * at the same size, codec and frame rate, so re-encoding would cost minutes
 * and a generation of quality to produce a file identical to the copy.
 *
 * Returns null rather than throwing when ffmpeg is missing. A project whose
 * shots all rendered has succeeded; not being able to staple them together is
 * a missing convenience, and failing the whole thing over it would throw away
 * work that is already paid for.
 */
/**
 * What a clip's streams look like, for deciding whether they can be copied.
 */
interface ClipStreams {
  hasAudio: boolean;
  /** Video shape that has to match across a join: size, rate, pixel format. */
  videoSignature: string | null;
  /** Real length of each track, which are not always the same number. */
  videoSeconds: number;
  audioSeconds: number;
}

async function probeStreams(file: string): Promise<ClipStreams> {
  // ffmpeg exits non-zero for `-i` with no output mapping on some builds, so
  // the stderr is read either way — the stream listing is printed regardless.
  const info = (await runFfmpeg(["-i", file, "-f", "null", "-"])) ?? "";
  const video = /Stream #\d+:\d+.*: Video: (.+)/.exec(info)?.[1] ?? null;
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(info);

  const [videoSeconds, audioSeconds] = await Promise.all([
    video ? streamSeconds(file, "v") : Promise.resolve(0),
    hasAudio ? streamSeconds(file, "a") : Promise.resolve(0),
  ]);

  return {
    hasAudio,
    videoSeconds,
    audioSeconds,
    videoSignature: video
      ? [
          /(\d{2,5}x\d{2,5})/.exec(video)?.[1] ?? "",
          /([\d.]+) fps/.exec(video)?.[1] ?? "",
          /(yuv\w+|rgb\w+)/.exec(video)?.[1] ?? "",
        ].join("/")
      : null,
  };
}

/**
 * How long one track actually runs.
 *
 * The container's `Duration:` is the longest stream, not each stream, so it
 * cannot answer this — and using it where a per-track length was meant is
 * exactly how a video ends up with sound playing over a picture that has
 * already finished. Decoding the single mapped stream and reading the last
 * timestamp reported gives the real figure.
 */
async function streamSeconds(file: string, stream: "v" | "a"): Promise<number> {
  const out = await runFfmpeg(["-i", file, "-map", `0:${stream}:0`, "-f", "null", "-"]);
  if (out === null) return 0;
  return (
    lastMatch(out, /time=(\d+):(\d+):([\d.]+)/, (m) =>
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
    ) ?? 0
  );
}

/**
 * Put one clip into the exact shape every other clip is in.
 *
 * The audio is always re-encoded, and that is the point of this function.
 *
 * An MP4 carries a single decoder configuration per track. Joining with
 * `-c copy` writes only the *first* input's configuration, so every later
 * clip's packets are then decoded against settings they were not encoded with.
 * The file still reports the full duration and the picture still plays; the
 * sound stops at the first join. Seen on a two-shot piece where 13.0 seconds of
 * a 24.3-second video decoded and the rest returned "Invalid data found when
 * processing input" — the two clips had come down different paths, one
 * performed natively by the video model and one lip-synced, and nothing in the
 * pipeline had ever required them to agree.
 *
 * Re-encoding the audio is cheap next to a video re-encode, and it is what
 * makes the fast `-c copy` join safe rather than lucky. A clip with no audio at
 * all gets silence, so a scene without a line cannot cut the sound off either.
 */
async function normalizeForConcat(
  input: string,
  output: string,
  streams: ClipStreams,
  copyVideo: boolean,
  targetFps: string | null,
): Promise<string | null> {
  /**
   * Re-encoding is not enough on its own — the rate has to be forced.
   *
   * Without `-r`, each clip is re-encoded at whatever rate it already had, so
   * clips that disagreed still disagree afterwards and the join is still wrong.
   * The concat demuxer keeps the first input's timebase, so a 25fps clip
   * appended to a 24fps one is played slow: 24 seconds of material came back as
   * a 26.15-second file. Forcing one rate is what actually makes the parts
   * interchangeable.
   */
  /**
   * Both tracks are made exactly as long as each other, and this is the part
   * that matters most.
   *
   * The concat demuxer joins each stream independently: all the video, then all
   * the audio. So if one clip's audio is a second longer than its picture,
   * every clip after it has its sound start a second early, and the error adds
   * up down the timeline. That is what a video sounding fine over the first
   * scene and out of step from the second onwards actually is — not a lip-sync
   * failure in the second shot, but the first shot's tracks being different
   * lengths. Measured on a two-scene render: 22.4s of picture carrying 30.9s of
   * sound, still talking long after the video had ended.
   *
   * The shorter track is padded rather than the longer one trimmed — video by
   * holding its last frame, audio by silence. Trimming would be simpler and
   * would cut words off the end of a line somebody approved.
   */
  const target = Math.max(streams.videoSeconds, streams.audioSeconds);
  const videoShort = target - streams.videoSeconds;
  const needsVideoPad = streams.hasAudio && videoShort > STREAM_SKEW_TOLERANCE;

  const videoArgs =
    copyVideo && !needsVideoPad
      ? ["-c:v", "copy"]
      : [
          ...(needsVideoPad
            ? ["-vf", `tpad=stop_mode=clone:stop_duration=${videoShort.toFixed(3)}`]
            : []),
          "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          ...(targetFps ? ["-r", targetFps] : []),
        ];

  const args = streams.hasAudio
    ? ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0"]
    : [
        "-y",
        "-i", input,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map", "0:v:0", "-map", "1:a:0",
      ];

  const done = await runFfmpeg([
    ...args,
    ...videoArgs,
    // `apad` covers the opposite skew — audio shorter than picture — and `-t`
    // stops both tracks on the same frame regardless of which was padded.
    "-af", "apad",
    "-c:a", "aac", "-ar", String(CONCAT_SAMPLE_RATE), "-ac", "2", "-b:a", "192k",
    "-t", target.toFixed(3),
    "-movflags", "+faststart",
    output,
  ]);
  return done === null ? null : output;
}

/** Below this, two tracks count as the same length and nothing is padded. */
const STREAM_SKEW_TOLERANCE = 0.04;

const CONCAT_SAMPLE_RATE = 44100;

/**
 * Speed a recording up slightly, without changing its pitch.
 *
 * `atempo` resamples in the time domain, so a voice sped up this way keeps its
 * timbre — it sounds like the same person speaking a little faster, not like a
 * tape played fast. That property is the whole reason this is safe to do to a
 * take that has already been approved.
 *
 * Used to make a narration fit the clip it has to play under. The alternative,
 * which is what happened before, is that the lip-sync model stretches the
 * *picture* to cover an over-long recording, and re-timing the picture slides
 * the mouth out of step with the words for the rest of the shot.
 *
 * Returns null if ffmpeg is unavailable or the factor is outside what stays
 * inaudible — the caller then keeps the original and reports the overrun rather
 * than shipping an obviously hurried read.
 */
export async function compressAudio(
  inputPath: string,
  outputPath: string,
  factor: number,
): Promise<{ outputPath: string; seconds: number } | null> {
  if (!(await ffmpegAvailable())) return null;
  if (!(factor > 1) || factor > MAX_SPEEDUP) return null;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const done = await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-filter:a", `atempo=${factor.toFixed(4)}`,
    // Re-encoded rather than copied: the filter has to actually run, and the
    // bitrate matches what the voice provider returns.
    "-c:a", "libmp3lame", "-b:a", "128k",
    outputPath,
  ]);
  if (done === null) return null;

  const probe = await runFfmpeg(["-i", outputPath, "-f", "null", "-"]);
  const seconds =
    probe === null
      ? null
      : lastMatch(probe, /Duration: (\d+):(\d+):([\d.]+)/, (m) =>
          Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
        );
  if (seconds === null) return null;
  return { outputPath, seconds };
}

/**
 * The most a take may be sped up before anyone can hear it.
 *
 * Ten percent is about the limit at which a listener stops noticing pace and
 * starts noticing rush. Past it the honest answer is that the line is too long
 * for the shot, which is a writing problem and is reported as one.
 */
export const MAX_SPEEDUP = 1.1;

/**
 * Put the narration in a room.
 *
 * Two things are wrong with synthesised speech laid straight onto a picture,
 * and they are both absences. There are no reflections — nothing in the sound
 * says the speaker is standing anywhere — and between the words there is true
 * digital silence, measured at −138 dBFS on a finished cut, which is a number
 * that exists nowhere outside a computer. The result is a voice that reads as
 * synthetic before anyone has judged the voice itself.
 *
 * The wet branch is band-limited before it is delayed. Rooms absorb the top and
 * the bottom — reflected sound is duller than direct sound — so a full-range
 * reverb sounds like an effect, and a 170–4800 Hz one sounds like plaster.
 *
 * Three `aecho` stages rather than one, because a room is dense. Each stage
 * re-echoes the one before it, so the tap counts multiply: 5 × 3 × 3 is 45
 * reflections instead of the four a single stage gives, and the delays are
 * chosen not to be multiples of each other so they do not stack into a pitched
 * flutter. Measured on a speech-band burst at the default amount, the tail
 * leaves the word at −17 dB and is gone by 200ms — a small furnished room, not
 * a hall.
 *
 * The pink noise is the other half, and arguably the more important one. It
 * lifts the floor to about −56 dBFS, some 33 dB under the speech, which is
 * inaudible as noise and audible as presence. It also runs unbroken across the
 * joins between shots, so a cut of four separately-rendered clips stops
 * sounding like four clips.
 *
 * Runs on the joined cut and before the music, so the voice gets the room and
 * the bed stays clean — a bed with reverb on it just sounds badly recorded.
 *
 * Returns null when ffmpeg is missing or the video has no audio; the caller
 * keeps the untreated cut, which is a complete video.
 */
export async function applyRoomTone(
  videoPath: string,
  outputPath: string,
  mix: RoomToneMix,
): Promise<MuxResult | null> {
  if (!(await ffmpegAvailable())) return null;
  if (!(mix.wet > 0)) return null;

  const probe = await runFfmpeg(["-i", videoPath, "-f", "null", "-"]);
  if (probe === null) return null;
  if (!/Stream #\d+:\d+.*: Audio:/.test(probe)) return null;

  // Same reason as the music mix: `aformat` pays the 3.01 dB pan law to widen
  // a mono track, and `pan` does not.
  const mono = /Stream #\d+:\d+.*: Audio:.*\bmono\b/.test(probe);
  const toStereo = mono ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo";

  const filter = [
    `[0:a]aformat=sample_fmts=fltp:sample_rates=44100,${toStereo},asplit=2[dry][src]`,
    `[src]highpass=f=170,lowpass=f=4800,${REFLECTIONS},volume=${mix.wet.toFixed(3)}[wet]`,
    `anoisesrc=c=pink:r=44100:a=${(await airAmplitude(videoPath, mix.air)).toFixed(5)}` +
      ",lowpass=f=2600,pan=stereo|c0=c0|c1=c0[air]",
    /**
     * `duration=first` is what stops this running forever.
     *
     * The noise source has no end, so the mix has to be bounded by an input
     * that does — the clip's own track, which is first. Without it the graph
     * never completes and the render hangs, the same way `-shortest` hangs on
     * an endless filtergraph.
     */
    "[dry][wet][air]amix=inputs=3:duration=first:normalize=0" +
      // Adding two signals to a track that was mastered near full scale can
      // only push the peaks up. Measured at +1.4 dB on a real cut, which had
      // the headroom; the limiter is here for the one that does not.
      ",alimiter=limit=0.95:level=disabled[out]",
  ].join(";");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const done = await runFfmpeg([
    "-y",
    "-i", videoPath,
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[out]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ]);
  if (done === null) return null;

  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}

export interface RoomToneMix {
  /** Level of the reflected signal against the dry voice, 0–1. */
  wet: number;
  /**
   * Amplitude of the pink-noise floor for a normally-mastered cut, 0–1. Tiny by
   * design, and scaled to the actual programme level — see `airAmplitude`.
   */
  air: number;
}

/**
 * The noise floor has to sit under *this* cut, not under a typical one.
 *
 * A fixed amplitude is right only for a fixed programme level. The clips this
 * pipeline produces measure around −20 to −25 dBFS RMS, where the default puts
 * the floor some 33 dB down and it reads as air. Hand it a quiet cut — a soft
 * voice, a scene the model rendered low — and the same absolute floor is only
 * 20 dB down, which is not air, it is hiss.
 *
 * So the level is measured and the floor placed a fixed distance beneath it.
 * Clamped both ways: a quarter of the nominal amplitude and four times it, so a
 * botched measurement cannot make the noise loud, or the effect vanish.
 *
 * Falls back to the nominal value whenever the measurement fails, which is the
 * behaviour this replaces.
 */
async function airAmplitude(videoPath: string, nominal: number): Promise<number> {
  const stats = await runFfmpeg(["-i", videoPath, "-af", "astats", "-f", "null", "-"]);
  const rms = stats === null ? null : firstMatch(stats, /RMS level dB: (-?[\d.]+)/, (m) => Number(m[1]));
  if (rms === null || !Number.isFinite(rms)) return nominal;

  // The reference level the nominal amplitude was chosen against.
  const scaled = nominal * 10 ** ((rms - REFERENCE_PROGRAMME_DBFS) / 20);
  return Math.min(nominal * 4, Math.max(nominal / 4, scaled));
}

/** Programme RMS the default `air` amplitudes were tuned at. */
const REFERENCE_PROGRAMME_DBFS = -23;

function firstMatch<T>(text: string, pattern: RegExp, map: (m: RegExpMatchArray) => T): T | null {
  const found = pattern.exec(text);
  return found ? map(found) : null;
}

/**
 * The reflection pattern, shared by both room sizes.
 *
 * Only the wet level changes between `light` and `room`: the same room, heard
 * from further back. Modelling a genuinely larger space would mean longer
 * pre-delay and a longer tail, which on a fifteen-second social clip is a
 * difference nobody hears and another two numbers to get wrong.
 */
const REFLECTIONS =
  "aecho=1:0.9:7|13|23|31:0.5|0.42|0.34|0.26," +
  "aecho=1:0.85:43|61:0.4|0.3," +
  "aecho=1:0.85:89|113:0.32|0.24";

/**
 * Measured, not guessed.
 *
 * Each was rendered against a speech-band burst and the decay read off the
 * result. `light` puts the tail 17 dB under the word and clears it in 200ms;
 * `room` puts it 14 dB under and takes 250ms. Past that it stops sounding like
 * a room the speaker is in and starts sounding like a room she is across.
 */
export const ROOM_TONE_MIX: Record<"light" | "room", RoomToneMix> = {
  light: { wet: 0.28, air: 0.004 },
  room: { wet: 0.45, air: 0.006 },
};

/**
 * Lay a music bed under a finished video, ducked beneath the narration.
 *
 * Ducking is the whole job. A bed mixed at a fixed level either sits so low it
 * may as well be absent, or rides over the words in the quiet parts — and the
 * quiet parts are where a talking-head video is doing its work. `sidechaincompress`
 * drives the music's gain from the speech: the bed pulls back whenever someone
 * talks and comes back up between lines, which is what a human mixer does and
 * is why the result reads as scored rather than as two files played at once.
 *
 * Note the operand order. The signal being compressed is the music and the
 * signal doing the triggering is the voice, so the music is the first input to
 * the filter and the voice the second; reversing them ducks the narration under
 * the music, which is precisely backwards.
 *
 * The bed is looped and then trimmed to the picture, so a bed that came back
 * slightly short of the requested length cannot leave the tail silent, and one
 * that came back long cannot extend the video. It fades out at the end because
 * music that stops dead on the last frame sounds like a mistake.
 *
 * Returns null when ffmpeg is missing or the video has no audio to duck
 * against — the caller keeps the unscored cut, which is a complete video.
 */
export async function mixBackgroundMusic(
  videoPath: string,
  musicPath: string,
  outputPath: string,
  level: number,
): Promise<MuxResult | null> {
  if (!(await ffmpegAvailable())) return null;

  const gain = Math.min(1, Math.max(0, level));
  if (gain === 0) return null;

  // One probe for both facts. Reading them separately means decoding the whole
  // video twice to learn two things that arrive in the same output.
  const probe = await runFfmpeg(["-i", videoPath, "-f", "null", "-"]);
  if (probe === null) return null;
  if (!/Stream #\d+:\d+.*: Audio:/.test(probe)) return null;

  /**
   * Bounded by the picture, not by the container.
   *
   * `Duration:` reports the longest stream. Reading the length from it meant
   * that a cut whose audio already outran its video had the overrun preserved
   * — and, with the bed padded to match, extended — instead of being cut back
   * to the last frame. Seen on a render that ended its picture at 22.4s and
   * kept talking to 30.9s. The video track is the only honest answer to "how
   * long is this video".
   */
  const seconds = await streamSeconds(videoPath, "v");
  if (!(seconds > 0)) return null;
  // Fade the last stretch, but never more than a quarter of a short video —
  // a two-second fade on a five-second clip is a fade, not an ending.
  const fade = Math.min(MUSIC_FADE_SECONDS, seconds / 4);
  const fadeStart = Math.max(0, seconds - fade);

  /**
   * Widening a mono narration track to stereo has to be done by hand.
   *
   * `aformat` applies the standard −3 dB pan law when it converts mono to
   * stereo: correct for preserving total power across a room, wrong here,
   * where it quietly drops the narration by 3 dB in every scored video.
   * Measured at exactly 3.01 dB on a real clip. `pan` copies the channel
   * instead, leaving the voice at the level it was mastered at.
   */
  const mono = /Stream #\d+:\d+.*: Audio:.*\bmono\b/.test(probe);
  const toStereo = mono
    ? "pan=stereo|c0=c0|c1=c0"
    : "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

  const filter = [
    // Match formats before mixing; the clip's track and the bed rarely agree
    // on sample rate, and amix resamples badly when left to guess.
    // `apad` matters when a clip's audio track is shorter than its picture.
    // Bounding the mix by the voice would then end the bed early and leave the
    // tail of the video bare, which reads as the music cutting out. Padded
    // here and bounded by `-t` below, the bed covers exactly the picture.
    `[0:a]aformat=sample_fmts=fltp:sample_rates=44100,${toStereo},apad,asplit=2[voice][key]`,
    `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${gain},apad[bed]`,
    // attack short enough to catch the first syllable, release long enough
    // that the bed does not pump between words within a sentence.
    "[bed][key]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350" +
      `,afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}[ducked]`,
    // `duration=first` bounds the mix to the picture's own track; normalize=0
    // keeps the voice at the level it was mastered at instead of halving it.
    "[voice][ducked]amix=inputs=2:duration=first:normalize=0[out]",
  ].join(";");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const done = await runFfmpeg([
    "-y",
    "-i", videoPath,
    /**
     * Loop the bed at the input, not in the filter graph.
     *
     * `aloop` was doing this and silently was not: given a bed shorter than the
     * picture the graph simply ended when the bed did, and the *whole video*
     * came out cropped to the music. A 26.8-second cut with a 15-second bed
     * returned a 14.4-second file — three scenes of finished, paid-for footage
     * thrown away by the garnish, with no error anywhere.
     *
     * `-stream_loop -1` repeats the file itself, which cannot run out, and the
     * `-t` below is what decides the length. `apad` on the bed is a second
     * belt: if a decoder ever refuses to loop, the bed goes quiet and the
     * picture still survives intact.
     */
    "-stream_loop", "-1",
    "-i", musicPath,
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[out]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    // Both the padded voice and the looped bed are endless by construction, so
    // the output length is set here rather than by whichever input runs out.
    //
    // `-shortest` is the obvious alternative and does not work: with a
    // filtergraph output that never ends it does not terminate, and the mix
    // hangs indefinitely. The small margin covers the duration being read from
    // ffmpeg's two-decimal summary — rounded down, an exact `-t` would clip the
    // copied video's final frame. Overshooting instead leaves at most a few
    // milliseconds of already-faded audio past the last frame, which is
    // inaudible, where undershooting loses picture.
    "-t", (seconds + END_MARGIN_SECONDS).toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ]);
  if (done === null) return null;

  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}

/** How long the bed takes to fade out at the end, when the video is long enough. */
const MUSIC_FADE_SECONDS = 1.8;

/** Slack on the output length, wide enough to cover a rounded-down duration. */
const END_MARGIN_SECONDS = 0.05;

export async function concatVideos(
  inputs: string[],
  outputPath: string,
): Promise<MuxResult | null> {
  if (inputs.length === 0) return null;
  if (!(await ffmpegAvailable())) return null;

  /**
   * Bring every clip into the same shape before copying them together.
   *
   * Shots reach this point down different paths — performed natively by the
   * video model, lip-synced afterwards, muxed here, re-encoded after a trim —
   * and nothing upstream requires the results to agree with each other. The
   * concat demuxer with `-c copy` assumes they do, and produces a file that
   * looks right and is broken past the first join when they do not.
   *
   * Audio is normalised for every clip, always. Video is copied when all the
   * clips already agree on size, rate and pixel format, and re-encoded only
   * when they do not — so the common case stays fast and the mixed case stops
   * being broken.
   */
  const streams = await Promise.all(inputs.map(probeStreams));
  const signatures = new Set(streams.map((s) => s.videoSignature).filter(Boolean));
  const copyVideo = signatures.size <= 1;
  // The first clip's rate is the one to match: the demuxer imposes it on
  // everything that follows anyway, so making the others actually be that rate
  // is what stops them playing at the wrong speed.
  const targetFps = streams.find((s) => s.videoSignature)?.videoSignature?.split("/")[1] || null;

  const prepared: string[] = [];
  const scratch: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const normalized = `${outputPath}.part-${index}.mp4`;
    // Registered for cleanup *before* the attempt, not after a successful one.
    // ffmpeg runs with `-y` and creates its output file before it discovers it
    // cannot finish, so a normalize that fails still leaves a part file behind
    // — and the version that only tracked successes left exactly those behind,
    // in the project folder, named like fragments of the deliverable.
    scratch.push(normalized);
    const result = await normalizeForConcat(
      input,
      normalized,
      streams[index],
      copyVideo,
      targetFps,
    );
    prepared.push(result ?? input);
  }

  const listPath = `${outputPath}.concat.txt`;
  // Single quotes are the demuxer's escape, and a path containing one would
  // otherwise end the argument early.
  const list = prepared.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(listPath, `${list}\n`, "utf8");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        FFMPEG,
        [
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", listPath,
          "-c", "copy",
          "-movflags", "+faststart",
          outputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
      });
      child.on("error", (cause) => reject(new Error(`Could not run ffmpeg: ${cause.message}`)));
      child.on("exit", (code) => {
        if (code === 0) return resolve();
        const why = complaint(stderr);
        reject(new Error(`Could not join the shots${why ? `: ${why}` : ` (ffmpeg exited ${code})`}`));
      });
    });
    const stat = await fs.stat(outputPath);
    return { outputPath, bytes: stat.size };
  } catch (cause) {
    // ffmpeg creates its output before it discovers it cannot finish, so a
    // failed join leaves a truncated file sitting in the project folder under
    // the deliverable's own name. Nothing references it — the job threw — so
    // it is only there to be mistaken for the finished video.
    await fs.rm(outputPath, { force: true });
    throw cause;
  } finally {
    await fs.rm(listPath, { force: true });
    await Promise.all(scratch.map((file) => fs.rm(file, { force: true })));
  }
}
