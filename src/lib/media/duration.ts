/**
 * How long is this audio, really?
 *
 * The video model needs a clip length in seconds *before* it renders, and the
 * only honest source for that number is the narration that has to fit inside
 * it. Text-length estimates are off by 20-30% on a short line, which is the
 * difference between a clip that ends on the last word and one that hangs on
 * silence for a second — or cuts the word off.
 *
 * Parsing is done by hand rather than by shelling out to ffprobe, because
 * ffmpeg is optional on the machines this runs on (see media/ffmpeg.ts) and
 * because pulling in a decoder dependency is what made this app hard to install
 * the first time round. WAV and MP3 cover every format the voice providers
 * return today; anything else falls back to the text estimate.
 */

/** Average narration pace. Used only when the bytes cannot be parsed. */
const WORDS_PER_SECOND = 2.6;

export interface AudioDuration {
  seconds: number;
  /** How the number was arrived at — surfaced in job results, not decorative. */
  source: "wav" | "mp3" | "estimate";
}

/**
 * Measure an audio buffer. Never throws: an unparseable file yields the text
 * estimate, because failing a render over a duration probe would be absurd.
 */
export function audioDuration(bytes: Buffer, fallbackText = ""): AudioDuration {
  const wav = wavDuration(bytes);
  if (wav !== null) return { seconds: wav, source: "wav" };

  const mp3 = mp3Duration(bytes);
  if (mp3 !== null) return { seconds: mp3, source: "mp3" };

  return { seconds: estimateFromText(fallbackText), source: "estimate" };
}

/** Rough duration from a script line, for planning before audio exists. */
export function estimateFromText(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return words / WORDS_PER_SECOND;
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/**
 * RIFF/WAVE: walk the chunk list for `fmt ` (byte rate) and `data` (size).
 * Duration is one division once both are known.
 */
function wavDuration(bytes: Buffer): number | null {
  if (bytes.length < 44) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  if (bytes.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);

    if (id === "fmt " && offset + 8 + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(offset + 16);
    } else if (id === "data") {
      // Some encoders write 0 or 0xFFFFFFFF for streamed output; trust the
      // actual remaining bytes in that case.
      const remaining = bytes.length - (offset + 8);
      dataSize = size > 0 && size <= remaining ? size : remaining;
      break;
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }

  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

// Layer III bitrates in kbps, indexed by the 4-bit header field.
const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

interface Mp3Frame {
  offset: number;
  frameLength: number;
  sampleRate: number;
  samplesPerFrame: number;
  bitrateKbps: number;
  mpegVersion: number;
  channelMode: number;
}

function mp3Duration(bytes: Buffer): number | null {
  const start = skipId3(bytes);
  const frame = findFrame(bytes, start);
  if (!frame) return null;

  // VBR files carry a Xing/Info header in the first frame with the exact frame
  // count. That is the only accurate number for VBR — a bitrate calculation
  // would use the first frame's rate for the whole file and be badly wrong.
  const vbrFrames = xingFrameCount(bytes, frame);
  if (vbrFrames !== null && vbrFrames > 0) {
    return (vbrFrames * frame.samplesPerFrame) / frame.sampleRate;
  }

  if (frame.bitrateKbps <= 0) return null;
  // CBR: the audio payload divided by the constant bit rate.
  const audioBytes = bytes.length - frame.offset - trailingId3v1(bytes);
  if (audioBytes <= 0) return null;
  return (audioBytes * 8) / (frame.bitrateKbps * 1000);
}

/** ID3v2 tags sit in front of the audio and carry a synchsafe 32-bit length. */
function skipId3(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.toString("ascii", 0, 3) !== "ID3") return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return Math.min(bytes.length, 10 + size + footer);
}

/** A 128-byte ID3v1 tag at the tail is not audio and would inflate the duration. */
function trailingId3v1(bytes: Buffer): number {
  if (bytes.length < 128) return 0;
  return bytes.toString("ascii", bytes.length - 128, bytes.length - 125) === "TAG" ? 128 : 0;
}

/**
 * Find the first valid frame header, tolerating a little garbage before it.
 * A single sync word is not proof — 0xFF bytes occur in tag padding — so the
 * candidate is only accepted if a second frame lands exactly where this one
 * says it should.
 */
function findFrame(bytes: Buffer, from: number): Mp3Frame | null {
  const limit = Math.min(bytes.length - 4, from + 200_000);
  for (let i = from; i < limit; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const frame = parseFrameHeader(bytes, i);
    if (!frame) continue;

    const next = frame.offset + frame.frameLength;
    if (next + 1 >= bytes.length) return frame; // Single-frame file.
    if (bytes[next] === 0xff && (bytes[next + 1] & 0xe0) === 0xe0) return frame;
  }
  return null;
}

function parseFrameHeader(bytes: Buffer, offset: number): Mp3Frame | null {
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];

  const mpegVersion = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b1 >> 1) & 0x03; // 1 = Layer III
  if (mpegVersion === 1 || layer !== 1) return null;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const sampleRate = SAMPLE_RATES[mpegVersion]?.[sampleRateIndex];
  if (!sampleRate) return null;

  const bitrateKbps =
    mpegVersion === 3 ? BITRATES_MPEG1[bitrateIndex] : BITRATES_MPEG2[bitrateIndex];
  if (!bitrateKbps) return null;

  const samplesPerFrame = mpegVersion === 3 ? 1152 : 576;
  const padding = (b2 >> 1) & 0x01;
  const frameLength =
    Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (frameLength <= 4) return null;

  return {
    offset,
    frameLength,
    sampleRate,
    samplesPerFrame,
    bitrateKbps,
    mpegVersion,
    channelMode: (b3 >> 6) & 0x03,
  };
}

/**
 * Xing (VBR) or Info (CBR) header, if present. It sits after the frame's side
 * information, whose length depends on version and channel count.
 */
function xingFrameCount(bytes: Buffer, frame: Mp3Frame): number | null {
  const mono = frame.channelMode === 3;
  const sideInfo = frame.mpegVersion === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const tagOffset = frame.offset + 4 + sideInfo;
  if (tagOffset + 12 > bytes.length) return null;

  const tag = bytes.toString("ascii", tagOffset, tagOffset + 4);
  if (tag !== "Xing" && tag !== "Info") return null;

  const flags = bytes.readUInt32BE(tagOffset + 4);
  if ((flags & 0x01) === 0) return null; // No frame-count field.
  return bytes.readUInt32BE(tagOffset + 8);
}
