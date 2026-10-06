import type { CreatorLook } from "@/lib/look";
import type { VideoStyle } from "@/lib/video-style";

/**
 * Domain model.
 *
 * The central idea: a Creator owns an *identity kit* (a locked textual identity
 * block + anchor reference images + a voice config), while a Scene owns a
 * *creator-agnostic* description of what happens. Rendering = identity kit x
 * scene spec. Because the two never mix, swapping a creator is a pure
 * substitution: same scenes, same shots, same script beats, different person.
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

// Verified against the live image model by probing each value: every ratio
// here is accepted, and an invented one ("99:1") comes back
// "This aspect_ratio is not within the range of allowed options" — so this list
// is the model's, not a guess. 4:5 is here because it is Instagram's portrait
// feed crop and nothing else in the set is a substitute for it.
export const ASPECT_RATIOS = [
  "1:1",
  "4:5",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/**
 * What a project produces.
 *
 * `video` is the original path: storyboard, script, voice, clips. `photo` runs
 * the same machinery but stops at the still — a set of post-ready images with
 * no dialogue and nothing to animate. It exists because a social account is not
 * only reels: the brief asks for images sized for Instagram, Facebook,
 * LinkedIn and X, in portrait *and* landscape, and rendering a video to harvest
 * a frame from it is a wasteful way to get one.
 *
 * Deliberately a setting on a project rather than a separate entity. Creator
 * swapping, reference uploads, location plates, the shot editor and the export
 * bundle all work the same either way, and none of that is worth duplicating.
 */
export const PROJECT_KINDS = ["video", "photo"] as const;
export const MAX_PHOTO_COUNT = 12;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** Aspect presets offered for a photo set, by where the post is going. */
export const PHOTO_FORMATS = [
  { ratio: "4:5" as const, label: "Portrait 4:5 — Instagram feed" },
  { ratio: "1:1" as const, label: "Square 1:1 — feed, LinkedIn" },
  { ratio: "9:16" as const, label: "Vertical 9:16 — stories" },
  { ratio: "16:9" as const, label: "Landscape 16:9 — X, LinkedIn, banners" },
  { ratio: "3:2" as const, label: "Landscape 3:2 — general marketing" },
];

export const IMAGE_QUALITIES = ["basic", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/**
 * Canonical camera angles a creator's identity sheet can contain.
 *
 * Scene renders pull whichever of these best matches a shot's subject angle, so
 * the full set stays available — but it is no longer all generated up front.
 * See DEFAULT_IDENTITY_ANGLES.
 */
export const IDENTITY_ANGLES = [
  "front",
  "three_quarter",
  "profile",
  "rear",
  "close_up",
  "full_body",
] as const;

/**
 * What a new creator actually gets, automatically.
 *
 * Two frames, not six. A tight front close-up carries the face — the thing that
 * has to survive every later render — and a full body carries proportions,
 * posture and wardrobe. Between them they cover what an anchor is for.
 *
 * The other four were mostly waiting: six sequential renders is six times the
 * latency and cost before you can do anything with a creator, and a
 * three-quarter or rear anchor mainly helps shots that are themselves rare.
 * They can still be generated on demand from the creator page when a storyboard
 * genuinely calls for one.
 */
export const DEFAULT_IDENTITY_ANGLES = ["close_up", "full_body"] as const;
export type IdentityAngle = (typeof IDENTITY_ANGLES)[number];

export const IDENTITY_ANGLE_LABELS: Record<IdentityAngle, string> = {
  front: "Front",
  three_quarter: "Three-quarter",
  profile: "Side / profile",
  rear: "Rear",
  close_up: "Close-up",
  full_body: "Full body",
};

export const SHOT_TYPES = [
  "extreme_wide",
  "wide",
  "medium_wide",
  "medium",
  "medium_close_up",
  "close_up",
  "extreme_close_up",
  "over_the_shoulder",
  "pov",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export const CAMERA_MOVES = [
  "static",
  "slow_push_in",
  "slow_pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "tracking",
  "handheld",
  "orbit",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/**
 * Duration is any whole number of seconds in this range, not one of a fixed
 * set. The floor is one renderable clip; the ceiling is where a single brief
 * stops being one piece of content and starts being an edit.
 */
export const MIN_VIDEO_SECONDS = 5;
export const MAX_VIDEO_SECONDS = 90;

/** Offered as one-tap buttons. Any value in range is still accepted. */
export const VIDEO_DURATION_PRESETS = [15, 30, 60, 90] as const;

export type VideoDuration = number;

export function clampVideoDuration(seconds: number): VideoDuration {
  if (!Number.isFinite(seconds)) return 30;
  return Math.max(MIN_VIDEO_SECONDS, Math.min(MAX_VIDEO_SECONDS, Math.round(seconds)));
}

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

export interface VoiceConfig {
  provider: string;
  /** Provider-native voice identifier — locked for the creator's lifetime. */
  voiceId: string;
  label: string;
  /** 0..1 — higher is more consistent take-to-take. Key knob for voice consistency. */
  stability: number;
  /** 0..1 — adherence to the reference timbre. */
  similarityBoost: number;
  /** 0..1 — style exaggeration; kept low for predictable delivery. */
  style: number;
  /** 0.7..1.2 — speech rate. */
  speed: number;
  languageCode?: string;
}

export const DEFAULT_VOICE: VoiceConfig = {
  provider: "elevenlabs",
  // A *premade* ElevenLabs voice. Library voices return 402 on a free plan,
  // and only at render time — so the default has to be one that always works.
  // Laura is tagged young / social-media, which is the register this app is
  // for; the previous default (Jessica, tagged "cute") read as generic AI.
  voiceId: "FGY2WhTYpPnrIDTdsKH5",
  label: "Laura",
  /**
   * Stability 0.0 is the single most important number here.
   *
   * On v3 the scale is three-valued — 0.0 Creative, 0.5 Natural, 1.0 Robust —
   * and everything above Creative is a brake on delivery. The old 0.75 landed
   * in the flat, over-controlled register that is exactly what people mean by
   * "sounds like AI"; 0.5 was better and still even — same stress on every
   * clause, and the audio tags this pipeline writes into every line largely
   * ignored. Creative is the mode that actually performs them, and performance
   * is the whole difference between a read and a person talking.
   *
   * Consistency across videos comes from locking the voice *id*, not from
   * suppressing delivery — which is what makes spending the stability budget on
   * expressiveness safe rather than reckless.
   */
  stability: 0.0,
  /**
   * Raised with stability off the brake, not independently of it.
   *
   * Creative mode is free to vary the read, and similarity is what keeps that
   * variation inside the chosen voice instead of drifting toward a generic one.
   * At 0.75 the two changes would have fought each other.
   */
  similarityBoost: 0.9,
  /**
   * Nudged down for the same reason similarity went up.
   *
   * Style exaggerates the voice's own mannerisms, and it now stacks on top of
   * the expressiveness Creative mode has already unlocked. Past this the read
   * starts performing *at* the listener, which is its own kind of synthetic.
   */
  style: 0.35,
  speed: 1.0,
};

/**
 * v3 accepts only three stability values; anything else is rejected or snapped
 * server-side. Kept next to the default so the two cannot drift apart.
 */
export const V3_STABILITY_STEPS = [0.0, 0.5, 1.0] as const;

/**
 * The locked identity block. Authored once (by Claude, from the creator's
 * reference images) and thereafter injected verbatim into every prompt. Editing
 * it is an explicit, visible act — that is what stops drift.
 */
export interface IdentityBlock {
  /** One-paragraph canonical description used as the prompt preamble. */
  canonical: string;
  face: string;
  hair: string;
  skinTone: string;
  bodyType: string;
  distinguishingFeatures: string;
  /** Default wardrobe, used when a scene does not specify clothing. */
  wardrobe: string;
  /** Traits that must never appear — drift guards. */
  negative: string;
}

export interface CreatorReference {
  id: string;
  creatorId: string;
  /** `seed` = user-uploaded truth. `sheet` = generated canonical angle. */
  kind: "seed" | "sheet";
  angle: IdentityAngle | null;
  /** Publicly reachable URL the image provider can fetch. */
  remoteUrl: string;
  /** Local path under DATA_DIR/assets, served via /api/assets. */
  localPath: string | null;
  /** Whether this reference is fed to the model as an identity anchor. */
  isAnchor: boolean;
  createdAt: string;
}

export interface Creator {
  id: string;
  name: string;
  category: string;
  /** Short human-facing bio; also fed to the LLM for on-brand scripting. */
  persona: string;
  /**
   * The operator's own description of how this creator should look.
   *
   * Stored rather than consumed once: it is the brief the identity block was
   * written from, so keeping it is what makes "that is not what I asked for —
   * do it again" possible without rebuilding the creator from scratch.
   */
  appearanceNotes: string;
  /** Structured appearance picks. Empty object when nothing was chosen. */
  look: CreatorLook;
  identity: IdentityBlock;
  voice: VoiceConfig;
  /** Deterministic seed folded into prompts so repeat renders are stable. */
  promptSeed: string;
  status: "draft" | "ready";
  createdAt: string;
  updatedAt: string;
}

export interface CreatorWithRefs extends Creator {
  references: CreatorReference[];
}

// ---------------------------------------------------------------------------
// Scene / storyboard — deliberately creator-agnostic
// ---------------------------------------------------------------------------

/**
 * Everything needed to render a shot *except* who is in it. The creator is
 * referenced only by the literal token `{CREATOR}` inside `action` and
 * `sceneDescription`, which the prompt compiler substitutes at render time.
 */
export interface SceneSpec {
  /**
   * Which location this shot happens in, as a stable slug like
   * `mission_control_red`.
   *
   * Scenes sharing a key share a generated *location plate* — one empty render
   * of the room, with nobody in it, fed back as a reference to every shot set
   * there. Without it each scene invents its own version of "the office" and
   * the piece reads as five unrelated places; with it, cutting between shots
   * feels like moving around one room.
   *
   * It is deliberately separate from `environment`: the key says *which place*,
   * the text says *what the camera sees of it*.
   */
  locationKey: string;
  shotType: ShotType;
  cameraMove: CameraMove;
  /** Which identity-sheet angle best anchors this shot. */
  subjectAngle: IdentityAngle;
  /** What the creator is doing. Uses `{CREATOR}` as the subject placeholder. */
  action: string;
  facialExpression: string;
  pose: string;
  wardrobe: string;
  environment: string;
  lighting: string;
  mood: string;
  styleNotes: string;
  /** Motion description handed to the video model. */
  motion: string;
  /**
   * Who is heard, and whether their mouth is in the picture. See SpeechMode.
   *
   * Optional, and absent on every scene written before it existed: absence
   * means `on_camera`, which is exactly how those scenes were rendered. The
   * scene fingerprints treat an unset value and `on_camera` identically, so
   * adding the field invalidated nothing that was already rendered.
   */
  speechMode?: SpeechMode;
}

/**
 * How a scene's line is performed.
 *
 * `on_camera` — the presenter visibly says the line to the lens. The mouth has
 * to match the recording, so the clip must be performed from the voice
 * (native speech or a lip-sync pass). Overlaying a recording onto a clip whose
 * mouth was invented separately does not match, and is refused before any
 * paid render (see speechModeGate).
 *
 * `voiceover` — the line is narration heard over the shot. The subject is
 * rendered non-speaking, the video model never receives the words or the
 * waveform, and the exact recorded take is attached as-is. The natural mode
 * for narrated travel and B-roll, where nothing about the picture needs to be
 * lip-read.
 */
export const SPEECH_MODES = ["on_camera", "voiceover"] as const;
export type SpeechMode = (typeof SPEECH_MODES)[number];
export const DEFAULT_SPEECH_MODE: SpeechMode = "on_camera";

export const SPEECH_MODE_LABELS: Record<SpeechMode, string> = {
  on_camera: "On camera — the presenter says the line to the lens",
  voiceover: "Voice-over — narration over the shot, presenter not speaking",
};

/**
 * A generated reference image of a place or an object, with no people in it.
 *
 * Shot-to-shot consistency has two halves. The creator's identity kit keeps the
 * *person* the same; a plate keeps the *world* the same. Both work the same
 * way — render it once, then pass it back as a reference on every shot that
 * needs it, rather than hoping the model re-imagines it identically.
 */
export interface Plate {
  id: string;
  projectId: string;
  /** `location` = a room or place. `prop` = an object that recurs across shots. */
  kind: "location" | "prop";
  /** Stable slug scenes refer to. */
  key: string;
  label: string;
  /** The description this plate was rendered from, kept for regeneration. */
  description: string;
  remoteUrl: string | null;
  localPath: string | null;
  createdAt: string;
}

export interface Scene {
  id: string;
  projectId: string;
  index: number;
  title: string;
  spec: SceneSpec;
  /** Spoken line for this scene. Empty for B-roll. */
  dialogue: string;
  /** Seconds. Sums to the project's target duration. */
  durationSeconds: number;
  /**
   * The exact keyframe the operator approved for animation.
   *
   * This stores an asset id rather than a boolean: once a newer still is
   * rendered, the old approval cannot accidentally authorise the new image.
   */
  approvedImageAssetId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * How a scene's voice track is joined to its clip.
 *
 * `lipsync` is the default because a talking-head reel where the mouth does not
 * match the words is not usable output. It degrades on its own: if the lip-sync
 * model is unavailable it falls back to `mux`, and if ffmpeg is missing too it
 * falls back to `separate`. Each fallback is recorded on the asset rather than
 * failing the render.
 */
export const AUDIO_MODES = ["lipsync", "mux", "separate"] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

/**
 * What actually happened to a clip's sound. Superset of AudioMode: `native`
 * cannot be *requested*, only reported — it means the video model generated
 * synchronised speech itself and no joining step was required.
 */
export type AudioOutcome = AudioMode | "native";

/**
 * Human names for the three outcomes.
 *
 * Only `lipsync` can be *requested* — it is the one that produces a matching
 * mouth, and offering the other two as choices mostly produced clips whose lips
 * did not line up. The other two remain as *outcomes*: when the voice take
 * falls outside the video model's reference window, the pipeline still renders
 * the shot and attaches the audio, and the scene card says which happened.
 */
export const AUDIO_MODE_LABELS: Record<AudioMode, string> = {
  lipsync: "In sync — the clip is performed from the voice",
  mux: "Overlay — voice attached, mouth not matched",
  separate: "Separate files — clip and voice side by side",
};

/**
 * How the piece is supposed to have been *captured*.
 *
 * This is the largest single lever on whether output reads as real. A shallow
 * depth of field, an anamorphic lens and a graded image say "produced" — which
 * on a social feed is indistinguishable from "generated", because nobody films
 * themselves that way. The clips these creators are competing with were shot on
 * a phone held at arm's length in bad light, and matching that is what makes a
 * render stop looking synthetic.
 */
export type CaptureLook = "social" | "cinematic";

export const CAPTURE_LOOKS = ["social", "cinematic"] as const;

export const CAPTURE_LOOK_LABELS: Record<CaptureLook, string> = {
  social: "Phone — filmed on a phone, like a real post",
  cinematic: "Cinematic — lens character, shallow focus, graded",
};

export interface ProjectSettings {
  /** What this project produces. See ProjectKind. */
  kind: ProjectKind;
  /**
   * How many stills a photo set contains. Ignored for a video project.
   *
   * A separate field rather than reusing the duration: they are different
   * quantities with different bounds, and overloading one meant a three-image
   * set failed validation against a five-second floor that had nothing to do
   * with it.
   */
  photoCount: number;
  aspectRatio: AspectRatio;
  imageQuality: ImageQuality;
  targetDurationSeconds: VideoDuration;
  /** Exact number of cuts requested by the operator; omitted means automatic. */
  requestedSceneCount?: number;
  /**
   * The video model has one usable tier: 720p. Verified against the live API —
   * it accepts `480p` and `720p` and rejects `1080p` with `422 Invalid
   * resolution`. Kept as a field rather than deleted because it belongs in the
   * request and in the project chip, but it is not a choice anyone gets to make.
   */
  videoResolution: "720p";
  /** Free-text global direction applied to every shot. */
  globalStyle: string;
  audioMode: AudioMode;
  look: CaptureLook;
  /**
   * Structured direction for this particular piece — format, pacing, place,
   * time of day, outfit. Handed to the storyboard writer, not the renderer.
   * Optional: a project driven entirely by its brief text has none.
   */
  videoStyle?: VideoStyle;
  /**
   * Background music under the finished cut. Optional: projects created before
   * this existed have none, and absence means the same as `off`.
   */
  music?: MusicSettings;
  /**
   * How much room the narration sounds like it was recorded in. Optional for
   * the same reason as `music`; absence means the default, not `off`.
   */
  roomTone?: RoomTone;
}

/**
 * A little room around the voice, because a perfect one is the giveaway.
 *
 * Synthesised speech arrives anechoic: no reflections, and — the louder tell —
 * true digital silence between the words. Measured on a finished cut, the gaps
 * sat at −138 dBFS, a number that does not occur anywhere outside a computer.
 * Nothing in the picture matches that. The subject is visibly standing in a
 * kitchen and sounds like she is standing in a vacuum, and the mismatch is what
 * reads as fake even to someone who could not name what is wrong.
 *
 * So both halves are treated: early reflections put walls around the voice, and
 * a pink-noise floor takes the silence off the bottom. The floor also runs
 * continuously across the joins, which is the thing that makes a cut of four
 * separately-rendered clips sound like one recording instead of four.
 *
 * `light` is a small furnished room and is the default — the effect should be
 * felt rather than heard.
 */
export const ROOM_TONES = ["off", "light", "room"] as const;
export type RoomTone = (typeof ROOM_TONES)[number];

export const ROOM_TONE_LABELS: Record<RoomTone, string> = {
  off: "None — dry studio recording",
  light: "Light — sounds recorded in a room",
  room: "Roomy — a larger, more live space",
};

/**
 * Music beds, by the feeling asked for rather than by genre.
 *
 * A genre picker would be the wrong control here. The operator is writing a
 * thirty-second social video, not scoring a film, and the useful question is
 * what the piece should feel like — the prompt sent to the music model is
 * written from that.
 */
export const MUSIC_MOODS = ["off", "calm", "upbeat", "warm", "cinematic"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export interface MusicSettings {
  mood: MusicMood;
  /**
   * How loud the bed sits under the narration, 0–1.
   *
   * Low by default and low by design. Music on a talking-head video competes
   * with the one thing the video exists to deliver, and the failure mode is
   * not "too quiet to notice" — it is "cannot make out the words".
   */
  level: number;
}

export const MUSIC_MOOD_LABELS: Record<MusicMood, string> = {
  off: "None — narration only",
  calm: "Calm — soft ambient pads",
  upbeat: "Upbeat — light modern pulse",
  warm: "Warm — mellow and acoustic",
  cinematic: "Cinematic — sparse and wide",
};

/**
 * The level every project scores at.
 *
 * A number rather than a control. Where the bed should sit under a spoken line
 * is a mixing decision with one defensible answer, and exposing it as a slider
 * mostly produces videos mixed too loud by someone auditioning it without the
 * narration playing.
 */
export const MUSIC_LEVEL = 0.18;

export const DEFAULT_MUSIC: MusicSettings = { mood: "off", level: MUSIC_LEVEL };

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  kind: "video",
  photoCount: 4,
  aspectRatio: "9:16",
  // Both image models map `high` to their 2K tier and `basic` to 1K. Identity
  // holds up better at 2K — more pixels on the face is the whole game here.
  imageQuality: "high",
  targetDurationSeconds: 30,
  videoResolution: "720p",
  globalStyle: "",
  audioMode: "lipsync",
  // Defaults to the phone look: this is a tool for making social content, and a
  // clip that looks filmed beats one that looks produced on every feed it lands
  // on.
  look: "social",
  music: DEFAULT_MUSIC,
  // On by default. The dry take is the one that needs justifying, not the one
  // that sounds like it was recorded somewhere.
  roomTone: "light",
};

export interface Project {
  id: string;
  title: string;
  /** The natural-language brief the user typed. */
  prompt: string;
  creatorId: string;
  settings: ProjectSettings;
  /** Full narration script, aligned to the storyboard. */
  transcript: string;
  /** Place / mood-board reference URLs applied to every scene. */
  backgroundRefs: string[];
  /** Style reference URLs applied to every scene. */
  styleRefs: string[];
  /**
   * Photos of the outfit the creator should be wearing in this piece.
   *
   * Distinct from a style reference: this says "wear this garment", not "match
   * this grade", and it is weighted ahead of the other context references
   * because clothing sits on the subject rather than behind them.
   */
  wardrobeRefs: string[];
  /**
   * Set only after the operator has reviewed the script and every shot.
   * Preview images cannot be queued before this approval.
   */
  storyboardApprovedAt: string | null;
  status: "draft" | "storyboarded" | "rendering" | "ready";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithScenes extends Project {
  scenes: Scene[];
}

// ---------------------------------------------------------------------------
// Assets & jobs
// ---------------------------------------------------------------------------

export type AssetKind = "image" | "video" | "audio";

export interface Asset {
  id: string;
  kind: AssetKind;
  /** Owning project, if any. */
  projectId: string | null;
  /** Owning scene, if any. */
  sceneId: string | null;
  /** Which creator is depicted / speaking. Drives the swap comparison view. */
  creatorId: string | null;
  /** Provider URL (may expire) and the local mirror we serve from. */
  remoteUrl: string | null;
  localPath: string | null;
  /** The exact compiled prompt used, for reproducibility + debugging. */
  prompt: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export type JobType =
  | "storyboard"
  | "identity_sheet"
  | "scene_image"
  | "scene_video"
  | "scene_voice"
  | "creator_bootstrap"
  /** Joins the finished shots into the single video that was asked for. */
  | "project_cut";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Statuses that mean the job will never do any more work. */
export const TERMINAL_JOB_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  projectId: string | null;
  sceneId: string | null;
  creatorId: string | null;
  /** Type-specific payload. */
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  /** 0..100, mirrored from the provider when available. */
  progress: number;
  createdAt: string;
  updatedAt: string;
}
