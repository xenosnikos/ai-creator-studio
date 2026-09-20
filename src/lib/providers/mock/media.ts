import type {
  ImageProvider,
  ImageRequest,
  LipSyncProvider,
  LipSyncRequest,
  TaskHandle,
  TaskResult,
  VideoProvider,
  VideoRequest,
  VoiceOption,
  VoiceProvider,
  VoiceRequest,
} from "@/lib/providers/types";
import { ELEVENLABS_VOICES } from "@/lib/providers/kie/voice";

/**
 * Offline stand-ins for the media providers.
 *
 * These exercise the full pipeline — job queue, polling, asset persistence,
 * export — without calling a paid API, which makes UI work and end-to-end
 * demos cheap. They return `data:` URLs; the storage layer decodes those the
 * same way it downloads a real provider URL.
 *
 * Set IMAGE_PROVIDER / VIDEO_PROVIDER / VOICE_PROVIDER to `mock` to use them.
 */

/** Mock tasks resolve after a couple of polls so progress UI is exercised. */
const POLLS_UNTIL_DONE = 2;

const pending = new Map<string, { polls: number; url: string }>();

function register(url: string): TaskHandle {
  const taskId = `mock_${Math.random().toString(36).slice(2, 12)}`;
  pending.set(taskId, { polls: 0, url });
  return { taskId, provider: "mock" };
}

function advance(handle: TaskHandle): TaskResult {
  const entry = pending.get(handle.taskId);
  if (!entry) {
    return { status: "failed", progress: 0, urls: [], error: "Unknown mock task" };
  }
  entry.polls += 1;
  if (entry.polls < POLLS_UNTIL_DONE) {
    return {
      status: "pending",
      progress: Math.round((entry.polls / POLLS_UNTIL_DONE) * 100),
      urls: [],
    };
  }
  pending.delete(handle.taskId);
  return { status: "succeeded", progress: 100, urls: [entry.url], raw: { mock: true } };
}

// ---------------------------------------------------------------------------
// Placeholder rendering
// ---------------------------------------------------------------------------

const ASPECT_DIMENSIONS: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "4:3": [1152, 864],
  "3:4": [864, 1152],
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "2:3": [832, 1248],
  "3:2": [1248, 832],
  "21:9": [1344, 576],
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap text to a fixed column count for the placeholder card. */
function wrap(text: string, columns: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > columns) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/** Stable pastel hue derived from the prompt, so re-renders look consistent. */
function hueFor(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

function placeholderSvg(
  label: string,
  body: string,
  width: number,
  height: number,
): string {
  const hue = hueFor(body);
  const lines = wrap(body, Math.max(24, Math.floor(width / 16)), 8);
  const startY = height / 2 - (lines.length - 1) * 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 45% 22%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 60) % 360} 45% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <rect x="16" y="16" width="${width - 32}" height="${height - 32}" fill="none" stroke="hsl(${hue} 60% 60%)" stroke-width="2" stroke-dasharray="10 8" opacity="0.5"/>
  <text x="${width / 2}" y="56" font-family="monospace" font-size="22" fill="hsl(${hue} 70% 75%)" text-anchor="middle">${escapeXml(label)}</text>
  <!--
    Says what it is, in the picture itself. A placeholder that merely looks
    abstract gets mistaken for a failed or ugly generation; one that states it
    is a sample and names the fix cannot be misread.
  -->
  <text x="${width / 2}" y="${height / 2 - 96}" font-family="sans-serif" font-size="${Math.round(width / 11)}" font-weight="bold" fill="#ffffff" opacity="0.9" text-anchor="middle">SAMPLE</text>
  <text x="${width / 2}" y="${height / 2 - 60}" font-family="sans-serif" font-size="${Math.round(width / 30)}" fill="#ffffff" opacity="0.75" text-anchor="middle">Not a real render — add API keys in Settings</text>
  ${lines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${startY + i * 32}" font-family="sans-serif" font-size="20" fill="#e8ecf5" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join("\n  ")}
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Synthesise a real, playable WAV so the audio player in the UI works offline.
 * A gentle two-tone hum, length proportional to the script — enough to verify
 * that per-scene voiceover wiring and playback are correct.
 */
function placeholderWav(text: string): string {
  const sampleRate = 16000;
  // ~14 characters per second is close to natural narration pace.
  const seconds = Math.max(1.5, Math.min(30, text.length / 14));
  const sampleCount = Math.floor(sampleRate * seconds);
  const baseFreq = 180 + (hueFor(text) % 90);

  const data = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    // Fade in/out so it does not click.
    const envelope = Math.min(1, t * 4, (seconds - t) * 4);
    const sample =
      Math.sin(2 * Math.PI * baseFreq * t) * 0.25 +
      Math.sin(2 * Math.PI * baseFreq * 1.5 * t) * 0.12;
    data.writeInt16LE(Math.round(sample * envelope * 32767 * 0.6), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return `data:audio/wav;base64,${Buffer.concat([header, data]).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export class MockImageProvider implements ImageProvider {
  readonly name = "mock:image";
  // Placeholder output is SVG, and this provider is the one thing that reads it.
  readonly acceptsVectorReferences = true;

  async submit(request: ImageRequest): Promise<TaskHandle> {
    const [width, height] = ASPECT_DIMENSIONS[request.aspectRatio] ?? [1024, 1024];
    const label = request.referenceUrls.length
      ? `MOCK IMAGE · i2i · ${request.referenceUrls.length} refs`
      : "MOCK IMAGE · t2i";
    return register(placeholderSvg(label, request.prompt, width, height));
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    return advance(handle);
  }

  async uploadImage(bytes: Buffer, _fileName: string, mimeType: string): Promise<string> {
    // Echo the bytes back as a data URL so downstream code has something real.
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  }
}

export class MockVideoProvider implements VideoProvider {
  readonly name = "mock:video";
  readonly minClipSeconds = 3;
  readonly maxClipSeconds = 15;

  async submit(request: VideoRequest): Promise<TaskHandle> {
    const [width, height] = [1280, 720];
    return register(
      placeholderSvg(
        `MOCK VIDEO · ${request.durationSeconds}s · ${request.resolution}`,
        request.prompt,
        width,
        height,
      ),
    );
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    return advance(handle);
  }
}

export class MockLipSyncProvider implements LipSyncProvider {
  readonly name = "mock:lipsync";

  async submit(_request: LipSyncRequest): Promise<TaskHandle> {
    // A placeholder clip cannot actually have its mouth driven, so this returns
    // a marked frame instead. It exists so the lip-sync stage is exercised
    // offline: ordering, polling, asset creation and the fallback chain are all
    // the same code paths the real provider runs through.
    return register(
      placeholderSvg("MOCK LIP SYNC", "Clip re-timed to the voice track.", 1280, 720),
    );
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    return advance(handle);
  }
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock:voice";

  async submit(request: VoiceRequest): Promise<TaskHandle> {
    return register(placeholderWav(`${request.voice.voiceId}:${request.text}`));
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    return advance(handle);
  }

  async listVoices(): Promise<VoiceOption[]> {
    return ELEVENLABS_VOICES;
  }
}
