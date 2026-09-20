/**
 * Provider contracts.
 *
 * Everything the app knows about image / video / voice / LLM vendors lives
 * behind these four interfaces. Swapping one image or video vendor for another
 * means writing one adapter and changing one env var — no application code
 * changes. See docs/PROVIDERS.md.
 *
 * All media providers are modelled as *async task* APIs (submit -> poll),
 * because that is the lowest common denominator: a synchronous provider simply
 * returns a terminal status on the first poll.
 */

import type { AspectRatio, ImageQuality, VoiceConfig } from "@/lib/types";

export interface TaskHandle {
  /** Provider-native task id. */
  taskId: string;
  /** Provider name, so a poll can be routed back to the right adapter. */
  provider: string;
}

export interface TaskResult {
  status: "pending" | "succeeded" | "failed";
  /** 0..100 when the provider reports it. */
  progress: number;
  /** Result URLs, present when status === "succeeded". */
  urls: string[];
  error?: string;
  /**
   * The task failed for a reason that says nothing about the request — the
   * provider was busy or had an internal error. Resubmitting is worthwhile;
   * these failures also consume no credits.
   */
  retryable?: boolean;
  /** Raw provider payload, retained for debugging. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export interface ImageRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  quality: ImageQuality;
  /**
   * Identity anchors + background/style references. When non-empty the adapter
   * MUST use its image-to-image path — this is what preserves the creator's
   * face and body across renders.
   */
  referenceUrls: string[];
  outputFormat?: "png" | "jpeg";
}

export interface ImageProvider {
  readonly name: string;
  /**
   * Can this provider read a vector (SVG) reference image?
   *
   * Only the placeholder provider can — it is the only thing that produces
   * them. Every real image model rejects them outright, so a creator seeded in
   * placeholder mode has to be re-seeded before it can render for real.
   *
   * Declared here rather than inferred from the provider's name: that was the
   * original implementation and it broke silently the moment an adapter was
   * called `mock:image` instead of `mock`.
   */
  readonly acceptsVectorReferences: boolean;
  submit(request: ImageRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
  /**
   * Submit the same request to a different model, for when the first refuses
   * it on content grounds.
   *
   * Image models are moderated by their vendors, and the vendors disagree
   * about where ordinary fashion stops — a wardrobe reference one refuses,
   * another renders. Optional, and returning null means there is no second
   * model to ask.
   */
  submitAlternate?(request: ImageRequest): Promise<TaskHandle | null>;
  /**
   * Make a local file reachable by the provider. Providers that accept raw
   * uploads implement this; others may return a data URL or a CDN link.
   */
  uploadImage(bytes: Buffer, fileName: string, mimeType: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoRequest {
  prompt: string;
  /**
   * Keyframe(s) the video is generated from. Always populated: we never do
   * text-to-video, because a keyframe is what carries identity into motion.
   */
  imageUrls: string[];
  /** Clip length in seconds. Providers clamp to their supported range. */
  durationSeconds: number;
  /** The video model has one tier; see ProjectSettings.videoResolution. */
  resolution: "720p";
  /** Output shape. Providers that take it explicitly must be told, or they default to landscape. */
  aspectRatio: AspectRatio;
  /**
   * The scene's voice track, when one exists.
   *
   * Only meaningful to providers with `speaksFromVoice`. They take it as a
   * reference and generate motion that is already speaking it, which is a
   * fundamentally better result than animating a keyframe and repairing the
   * mouth afterwards.
   */
  voiceUrl?: string;
  /** The line being spoken, for providers that benefit from knowing the words. */
  dialogue?: string;
}

export interface VideoProvider {
  readonly name: string;
  /** Per-clip limits, so the planner can split a 60s piece into legal clips. */
  readonly minClipSeconds: number;
  readonly maxClipSeconds: number;
  /**
   * The provider generates speech-synchronised motion from `voiceUrl` itself.
   *
   * When true the pipeline skips the separate lip-sync pass entirely: the clip
   * comes back already talking, with sound. Lip sync as a repair pass is
   * fragile — it has to detect, crop, regenerate and composite a face that the
   * video model has already committed to — so a model that never needs it is
   * the better path when one is available.
   */
  readonly speaksFromVoice?: boolean;
  /**
   * The usable duration window for `voiceUrl`, when `speaksFromVoice`.
   *
   * Outside it the provider rejects the whole request rather than coping — a
   * short line comes back as "audio duration must be greater than or equal to
   * 1.8" and the render fails. The planner needs to know the window so it can
   * fall back to attaching the voice after the fact instead of losing the clip.
   */
  readonly voiceReferenceSeconds?: { min: number; max: number };
  submit(request: VideoRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
}

// ---------------------------------------------------------------------------
// Lip sync
// ---------------------------------------------------------------------------

export interface LipSyncRequest {
  /** Silent (or ignored-audio) clip to re-time the mouth in. */
  videoUrl: string;
  /** The voice track the mouth must match. */
  audioUrl: string;
}

/**
 * Drives a rendered clip's mouth from an audio track.
 *
 * This is a separate provider because it is a separate class of model: an
 * image-to-video model animates a keyframe and cannot be told what is being
 * said. Lip sync is the only step in the pipeline that sees video and audio at
 * the same time.
 */
export interface LipSyncProvider {
  readonly name: string;
  submit(request: LipSyncRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface VoiceRequest {
  text: string;
  voice: VoiceConfig;
  /**
   * Preceding / following script text. Passing these keeps prosody continuous
   * across scene boundaries instead of resetting every clip.
   */
  previousText?: string;
  nextText?: string;
  /**
   * Delivery hint for models that accept one, e.g. `warmly`, `excited`.
   * Derived from the scene's mood rather than hand-written, so the read tracks
   * the shot instead of being uniformly flat across a project.
   */
  delivery?: string;
}

/**
 * A voice offered in the creator form.
 *
 * Carries more than an id and a label because picking a voice from a name
 * alone is guesswork, and a wrong guess is only discovered after a paid render.
 * The extra fields let the form describe the voice and, where the provider
 * supplies one, play a sample before it is committed to a creator.
 */
export interface VoiceOption {
  id: string;
  label: string;
  /**
   * Where the voice came from, which is also the order of preference.
   *
   * `account` is a voice this workspace created or added — the operator's own,
   * so nothing should ever rank above it. `library` is the curated shortlist
   * from the provider's shared catalogue, which is where the natural-sounding
   * voices are. `stock` is the default set every account ships with: usable,
   * and the ones that sound like text-to-speech, so they sort last.
   */
  source: "account" | "library" | "stock";
  /** Audio sample, when the provider publishes one. */
  previewUrl?: string;
  gender?: string;
  age?: string;
  accent?: string;
  /** One or two words on the delivery, e.g. `confident`, `calm`. */
  descriptive?: string;
  /** What the voice is pitched for, e.g. `social_media`. */
  useCase?: string;
  /**
   * A studio-cloned voice — the provider's highest-fidelity tier, built from
   * hours of recorded audio rather than a short sample. These are the ones that
   * do not read as text-to-speech.
   */
  premium?: boolean;
}

export interface VoiceProvider {
  readonly name: string;
  submit(request: VoiceRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
  /** Voices selectable when creating a creator. */
  listVoices(query?: VoiceQuery): Promise<VoiceOption[]>;
}

/** Narrowing for providers whose catalogue is too large to list in full. */
export interface VoiceQuery {
  search?: string;
  gender?: string;
  age?: string;
  accent?: string;
  useCase?: string;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LLMImagePart {
  mediaType: string;
  /** base64, no data-url prefix. */
  data: string;
}

export interface LLMJsonRequest<T> {
  /**
   * Which pipeline stage this call belongs to. Real adapters ignore it; the
   * mock adapter uses it to route to a deterministic canned generator.
   */
  task: "identity_block" | "storyboard" | "scene_prompt";
  system: string;
  user: string;
  /** Optional images for vision tasks (e.g. reading a creator's reference photos). */
  images?: LLMImagePart[];
  /** JSON Schema the response is constrained to. */
  schema: Record<string, unknown>;
  /** Runtime validator; the adapter retries once on validation failure. */
  parse: (value: unknown) => T;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  /** Structured generation — the only mode the app uses. */
  json<T>(request: LLMJsonRequest<T>): Promise<T>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
