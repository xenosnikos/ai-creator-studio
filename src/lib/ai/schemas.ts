import { z } from "zod";

import {
  CAMERA_MOVES,
  IDENTITY_ANGLES,
  SHOT_TYPES,
  type IdentityBlock,
  type ProjectKind,
  type SceneSpec,
} from "@/lib/types";

/**
 * JSON Schemas + runtime validators for every structured Claude call.
 *
 * The JSON Schema is what constrains generation; the zod schema is what the
 * app trusts. They are declared together so they cannot drift apart.
 */

// ---------------------------------------------------------------------------
// Identity block — read a creator's reference photos into a locked description
// ---------------------------------------------------------------------------

export const identityBlockZod = z.object({
  canonical: z.string().min(40),
  face: z.string().min(5),
  hair: z.string().min(3),
  skinTone: z.string().min(3),
  bodyType: z.string().min(3),
  distinguishingFeatures: z.string(),
  wardrobe: z.string().min(3),
  negative: z.string(),
});

export const identityBlockSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    canonical: {
      type: "string",
      description:
        "One dense paragraph (60-120 words) describing this exact person in a way a text-to-image model can reproduce: apparent age, sex, ethnicity, face shape, eyes, nose, mouth, jaw, hair, skin tone, build and figure. Match the operator's brief on all of these. Include the slight asymmetries and skin behaviour that make the face read as a real photographed human rather than a render — that is about the medium and never a reason to make the person less attractive than asked. Present tense, purely physical, no names, no scene, no camera direction, and none of the words 'flawless', 'porcelain' or 'airbrushed'.",
    },
    face: {
      type: "string",
      description:
        "Face shape, eyes, brows, nose, mouth, jawline — including how the two sides differ from each other, since no real face is symmetrical.",
    },
    hair: {
      type: "string",
      description:
        "Colour, length, texture, styling, plus how it actually behaves: where it parts unevenly, which strands escape, whether the hairline is even.",
    },
    skinTone: {
      type: "string",
      description:
        "Skin tone and undertone, plus real complexion behaviour: pore visibility, where it catches a sheen, where it flushes warm, how the tone shifts across the face. Clear and healthy is fine — a person with beautiful skin still has skin rather than a smooth surface. Never 'flawless', 'porcelain' or 'airbrushed', and never a list of blemishes.",
    },
    bodyType: {
      type: "string",
      description:
        "Height impression, build, proportions, posture, figure. Follow the operator's brief where it specifies any of these; where it is silent, choose something specific and believable.",
    },
    distinguishingFeatures: {
      type: "string",
      description:
        "USUALLY EMPTY. Leave it empty unless the operator's brief explicitly asks for a specific mark, or a supplied photo plainly shows one. Do not invent skin marks of any kind — the previous version of this description listed examples, and listing them is precisely what put them on every creator that followed. Glasses and visible tattoos belong here when they are actually part of the person; skin does not.",
    },
    wardrobe: {
      type: "string",
      description:
        "Signature everyday outfit, used when a scene does not specify clothing. Clothes this person already owns and has worn — with the softening, creasing or fading that implies — not a styled look fresh off the rail. Commit to ONE outfit and name one colour for each garment. Never offer alternatives: a field reading 'a charcoal or deep-burgundy blouse' is resolved independently by every render, so the same person turns up in charcoal in one shot and burgundy in the next. If two options both fit the persona, pick one.",
    },
    negative: {
      type: "string",
      description:
        "Comma-separated traits that must never appear, used as drift guards (e.g. 'different face, altered jawline, changed eye colour, extra facial hair'). Add 'skin smoothed' and 'face made symmetrical' to guard the photographic look. Only name a feature as removable if this person actually has it.",
    },
  },
  required: [
    "canonical",
    "face",
    "hair",
    "skinTone",
    "bodyType",
    "distinguishingFeatures",
    "wardrobe",
    "negative",
  ],
  additionalProperties: false,
};

export function parseIdentityBlock(value: unknown): IdentityBlock {
  return identityBlockZod.parse(value);
}

// ---------------------------------------------------------------------------
// Scene spec — shared by storyboard generation and free-form instruction parsing
// ---------------------------------------------------------------------------

const sceneSpecZod = z.object({
  // Defaulted rather than required: an older storyboard, or a scene built from
  // a free-form instruction, simply gets its own location.
  locationKey: z
    .string()
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscores only")
    .default("default"),
  shotType: z.enum(SHOT_TYPES),
  cameraMove: z.enum(CAMERA_MOVES),
  subjectAngle: z.enum(IDENTITY_ANGLES),
  action: z.string().min(3),
  facialExpression: z.string().min(2),
  pose: z.string().min(2),
  wardrobe: z.string(),
  environment: z.string().min(3),
  lighting: z.string().min(3),
  mood: z.string().min(2),
  styleNotes: z.string(),
  motion: z.string().min(3),
});

const sceneSpecJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    locationKey: {
      type: "string",
      description:
        "Stable slug for the PLACE this shot happens in — lowercase letters, digits and underscores only, e.g. 'mission_control' or 'ramen_counter'. REUSE THE SAME KEY for every scene set in the same place. One empty reference render is made per distinct key and fed back into every shot that uses it, which is what makes consecutive shots look like one location instead of several. Only invent a new key when the story genuinely moves somewhere else.",
    },
    shotType: { type: "string", enum: [...SHOT_TYPES] },
    cameraMove: { type: "string", enum: [...CAMERA_MOVES] },
    subjectAngle: {
      type: "string",
      enum: [...IDENTITY_ANGLES],
      description:
        "Which canonical identity-sheet angle best anchors this shot. Drives which reference image is fed back to the image model.",
    },
    action: {
      type: "string",
      description:
        "What the subject is doing. MUST refer to the subject as the literal token {CREATOR} and never by name, gender, age, or appearance.",
    },
    facialExpression: { type: "string" },
    pose: { type: "string" },
    wardrobe: {
      type: "string",
      description:
        "Clothing for this shot, or an empty string to inherit the creator's default. When non-empty, repeat the identical text in every project scene and name one exact colour, material and cut for every visible garment, including the lower-body garment; never leave 'skirt', 'trousers' or similar items uncoloured and never offer alternatives.",
    },
    environment: {
      type: "string",
      // No framing either: the shot type field owns that, and framing words
      // written in here reach the video model as an instruction to re-frame
      // a clip whose opening frame has already been approved.
      description:
        "Location and set dressing only. No people, and no camera framing — do not write " +
        "\"closer in\", \"tighter\", \"wider\" or \"out of focus\"; use the shot type for that.",
    },
    lighting: { type: "string" },
    mood: { type: "string" },
    styleNotes: { type: "string", description: "Film stock, grade, lens, rendering style." },
    motion: {
      type: "string",
      description:
        "Motion for the video model: how the subject and camera move over the clip. Also refers to the subject as {CREATOR}.",
    },
  },
  required: [
    "locationKey",
    "shotType",
    "cameraMove",
    "subjectAngle",
    "action",
    "facialExpression",
    "pose",
    "wardrobe",
    "environment",
    "lighting",
    "mood",
    "styleNotes",
    "motion",
  ],
  additionalProperties: false,
};

export const sceneSpecSchema = sceneSpecJsonSchema;

export function parseSceneSpec(value: unknown): SceneSpec {
  return sceneSpecZod.parse(value);
}

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

export const storyboardZod = z.object({
  title: z.string().min(2),
  transcript: z.string().min(10),
  scenes: z
    .array(
      z.object({
        title: z.string().min(2),
        durationSeconds: z.number().min(2).max(15),
        dialogue: z.string(),
        spec: sceneSpecZod,
      }),
    )
    .min(1)
    .max(12),
});

export type StoryboardResult = z.infer<typeof storyboardZod>;

/**
 * The shortest string that can be a line rather than a gesture at one.
 *
 * Twelve characters is about three words. Below that the writer has not written
 * narration, it has written a caption — and a two-word fragment is worse than
 * silence downstream: it still queues a voice render, and it comes back under
 * the window the video model can perform a voice reference from, so the shot
 * falls through to the lip-synced path it would otherwise have avoided.
 */
const MIN_DIALOGUE_CHARS = 12;

/**
 * How much of a video may be wordless, as a fraction of its scenes.
 *
 * Not zero, because a genuine cutaway exists and forbidding it outright would
 * make the writer pad a shot that wants to breathe. Not unbounded either: the
 * system prompt already says never to leave a line empty and models still do
 * it, and every silent scene is a stretch of finished video where the creator
 * stands there saying nothing while the viewer waits.
 */
const SILENT_SCENE_FRACTION = 0.25;

/**
 * Every video scene carries part of the script, bar a quarter of them.
 *
 * Enforced here rather than trusted to the prompt because the prompt has been
 * saying it for a while and this is the stage that can actually refuse: a
 * failed parse is retried with the schema restated, which costs one generation,
 * while a silent scene that gets through costs a render, a cut, and the
 * operator's time noticing the hole.
 *
 * Rounded down and floored at one, so the allowance is a real cutaway budget on
 * a long piece and exactly one free pass on a short one. A single-scene video
 * is therefore allowed to be silent — a one-shot piece with no line is a
 * legitimate thing to ask for, and it is the operator's brief that decides it.
 */
function enforceSpokenCoverage(
  value: z.infer<typeof storyboardZod>,
  ctx: z.RefinementCtx,
): void {
  const allowance = Math.max(1, Math.floor(value.scenes.length * SILENT_SCENE_FRACTION));
  const silent = value.scenes
    .map((scene, index) => ({ index, chars: scene.dialogue.trim().length }))
    .filter((scene) => scene.chars < MIN_DIALOGUE_CHARS);
  if (silent.length <= allowance) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["scenes"],
    message:
      `Scene${silent.length === 1 ? "" : "s"} ${silent
        .map((scene) => scene.index + 1)
        .join(", ")} have no usable line (under ${MIN_DIALOGUE_CHARS} characters), which is ` +
      `${silent.length} of ${value.scenes.length} scenes — at most ${allowance} may be silent ` +
      `B-roll. Write narration for every scene: each one carries part of the script, sized to ` +
      `its own duration. If a beat feels wordless, give it the quietest sentence rather than no ` +
      `sentence, and keep "transcript" equal to the scene dialogue concatenated in order.`,
  });
}

/**
 * The video parser. A photo set uses `storyboardZod` unrefined — its stills are
 * silent by definition, and the handler blanks any line that arrives anyway.
 */
export const videoStoryboardZod = storyboardZod.superRefine(enforceSpokenCoverage);

export const storyboardSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short punchy title for the piece." },
    transcript: {
      type: "string",
      description:
        "The complete voice-over script as continuous prose, exactly matching the concatenated scene dialogue in order. This is the deliverable transcript.",
    },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short label, e.g. 'Cafe entrance'." },
          durationSeconds: {
            type: "number",
            description:
              "Clip length in seconds, between 3 and 15. All scene durations must sum to the requested total duration.",
          },
          dialogue: {
            type: "string",
            description:
              "The line spoken during this scene. In a video EVERY scene needs one — a silent " +
              "scene is a hole in the finished piece, and at most a quarter of them may be " +
              "wordless B-roll before the storyboard is rejected. Empty string only for a photo " +
              "set, where nothing is spoken at all. Must be short enough to be spoken naturally " +
              "within durationSeconds (~2.5 words per second), and long enough to fill it.",
          },
          spec: sceneSpecJsonSchema,
        },
        required: ["title", "durationSeconds", "dialogue", "spec"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "transcript", "scenes"],
  additionalProperties: false,
};

/**
 * `kind` decides which rules apply, and it defaults to the strict one: a caller
 * that forgets to say what it is parsing gets narration enforced rather than
 * silently skipped.
 */
export function parseStoryboard(value: unknown, kind: ProjectKind = "video"): StoryboardResult {
  return kind === "photo" ? storyboardZod.parse(value) : videoStoryboardZod.parse(value);
}
