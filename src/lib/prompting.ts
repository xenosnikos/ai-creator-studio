import type {
  CameraMove,
  CaptureLook,
  Creator,
  CreatorReference,
  IdentityAngle,
  Project,
  Scene,
  SceneSpec,
  ShotType,
} from "@/lib/types";

/**
 * The prompt compiler.
 *
 * This is where identity consistency is actually enforced, and it is
 * deliberately a *pure function* rather than another LLM call: the same
 * (creator, scene) pair must compile to a byte-identical prompt every time, or
 * "repeatable results" is not a claim we can make.
 *
 * Compilation is a fixed pipeline:
 *
 *   [identity block] + [angle directive] + [shot grammar] + [scene spec]
 *   + [global style] + [negative guards] + [stability seed]
 *
 * The identity block always comes first and is copied verbatim from the
 * creator. The scene spec never mentions the creator by name — only the
 * `{CREATOR}` token — so swapping creators changes exactly one segment of the
 * output and nothing else.
 */

const SUBJECT_TOKEN = "{CREATOR}";

const SHOT_GRAMMAR: Record<ShotType, string> = {
  extreme_wide: "extreme wide shot, subject small in a large environment",
  wide: "wide shot, full figure with generous headroom and visible surroundings",
  medium_wide: "medium wide shot, subject framed from the knees up",
  medium: "medium shot, subject framed from the waist up",
  medium_close_up: "medium close-up, subject framed from the chest up",
  close_up: "close-up, head and shoulders filling the frame",
  extreme_close_up: "extreme close-up on the face, eyes dominant in frame",
  over_the_shoulder: "over-the-shoulder shot, foreground shoulder softly out of focus",
  pov: "point-of-view shot from the subject's eyeline",
};

const CAMERA_GRAMMAR: Record<CameraMove, string> = {
  static: "locked-off static camera",
  slow_push_in: "slow dolly push in toward the subject",
  slow_pull_out: "slow dolly pull out away from the subject",
  pan_left: "smooth camera pan to the left",
  pan_right: "smooth camera pan to the right",
  tilt_up: "smooth camera tilt upward",
  tilt_down: "smooth camera tilt downward",
  tracking: "tracking shot moving with the subject",
  handheld: "subtle handheld camera with natural micro-movement",
  orbit: "slow orbital move around the subject",
};

/**
 * How each canonical angle should be phrased to the image model. These strings
 * are fixed so the identity sheet is reproducible across creators, which is
 * what makes cross-creator comparison meaningful.
 */
export const ANGLE_DIRECTIVE: Record<IdentityAngle, string> = {
  front: "facing the camera directly, straight-on frontal view, both eyes visible and symmetrical",
  three_quarter: "turned roughly 45 degrees from camera, three-quarter view of the face",
  profile: "turned 90 degrees from camera, clean side profile, single eye visible",
  rear: "seen from behind, back of the head and shoulders toward camera, face not visible",
  close_up: "tight close-up on the face, skin texture and facial detail clearly resolved",
  // Spelled out because "full body" alone reliably comes back cropped at the
  // calves, and this frame is the anchor every scene borrows proportions from —
  // a crop here loses the legs and the stance for every shot built on it.
  full_body:
    "the entire body from the top of the head to the feet, both feet fully visible flat on the " +
    "floor, empty space above the head and below the feet, standing at full height, nothing " +
    "cropped by any edge of the frame; complete silhouette and proportions in frame",
};

/** Framing used when generating each identity-sheet shot. */
const ANGLE_FRAMING: Record<IdentityAngle, ShotType> = {
  front: "medium_close_up",
  three_quarter: "medium_close_up",
  profile: "medium_close_up",
  rear: "medium",
  close_up: "close_up",
  full_body: "wide",
};

/**
 * What makes a render read as a *photograph of a person* rather than an image
 * of a person, which is the single difference between "that's a creator" and
 * "that's AI".
 *
 * Image models default to the average of their training data, and the average
 * portrait is retouched: even skin, symmetrical features, no stray hairs. The
 * fix is not more quality words — asking for "photorealistic, 8k, highly
 * detailed" pushes *harder* into the hyperreal render look.
 *
 * The fix is also not blemishes, which was the first thing tried here and was
 * wrong. Asking for marks and imperfections makes a model spray moles across
 * every visible surface, and the result is unattractive without being any more
 * convincing. These creators front social content: they have to look good.
 *
 * What actually separates a photograph from a render is *texture under light* —
 * pores, sheen, vellus hair, real catchlights — plus subtle asymmetry, plus the
 * grooming a real person leaves the house with. Which specific marks this
 * person has belongs to the identity block, and nowhere else — naming any of
 * them here puts them on every creator.
 */
const HUMAN_REALISM =
  // Deliberately not a second skin block: SKIN above owns the pores and the
  // texture. What is left is the small asymmetric detail a render smooths out.
  "an authentic unretouched photograph of a real person, not a render: matte skin, soft vellus " +
  "hair along the jaw, real catchlights, lips with genuine texture, individual brow hairs and a " +
  "few flyaway strands, the two halves of the face subtly asymmetric, everyday makeup sitting on " +
  "the skin rather than erasing it, correct anatomy";

/**
 * Clear skin, stated positively, for a creator who was never given marks.
 *
 * The prohibition was already in AVOID, but by then it sat roughly ninetieth
 * in a hundred-item list, where a negation carries almost nothing — and the
 * quality block was simultaneously talking about "the marks named in the
 * identity", which is a positive mention of marks in a prompt for someone who
 * has none. A positive instruction beats a buried negative every time; that is
 * the lesson from the wardrobe reference and the phone in frame, and it is the
 * same lesson here.
 */
/**
 * Says only what the AVOID list cannot.
 *
 * This used to spell out "no moles, no freckles, no beauty spots, no birthmarks,
 * no scars, no spots and no pimples" — the same eight nouns the negative list
 * carries a few lines later, where a model actually acts on exclusions. 180
 * characters spent saying a thing twice, on a prompt that was over budget and
 * losing its camera and quality instructions off the end because of it.
 *
 * What survives is the part no negative can express: clear is not the same as
 * smoothed, and the texture has to stay.
 */
const CLEAR_SKIN =
  "The skin is clear and unblemished on the face, neck, chest, shoulders and arms — but clear is " +
  "not smoothed: keep the pores, the texture and the tonal variation";

/**
 * The capture side of the same problem: a specific camera, lens, aperture and
 * light source. Without them the model averages toward flat, evenly-lit,
 * heavily-graded stock photography, which is the other half of the AI look.
 */
const PHOTO_CAPTURE =
  "shot on a full-frame camera with an 85mm prime at f/2 in available light, gentle natural falloff, " +
  "true-to-life colour rather than a heavy grade, faint sensor noise in the shadows, " +
  "no beauty retouching, no skin smoothing, no filter";

/**
 * Conditions for the identity sheet: a plain white room and nothing else.
 *
 * The sheet is a reference, not a photograph anyone will publish — every real
 * scene supplies its own place and wardrobe on top of it. So the room is kept
 * deliberately empty and neutral, which also means the only thing varying
 * between the sheet's frames is the angle, which is what makes them usable as
 * anchors.
 *
 * "Nothing in the room" is stated several ways because a model given a room
 * will furnish it unasked, and a chair or a plant that appears in one angle and
 * not another is drift the anchors then carry into every scene.
 */
const SHEET_CONDITIONS =
  "a completely plain, empty, very white room — bare white walls, white floor, nothing else in " +
  "the frame at all: no furniture, no plants, no pictures, no props, no text, no decoration, " +
  "nobody else; bright soft even daylight filling the room from the front with only a faint soft " +
  "shadow under the jaw; relaxed natural expression with a hint of a smile, relaxed rather than " +
  "stiff, sharp focus on the eyes";

const GLOBAL_QUALITY =
  `${HUMAN_REALISM}, correct anatomy, consistent facial proportions, high real-world detail`;

/**
 * The same intent as GLOBAL_QUALITY, for renders with nobody in them. Location
 * and prop plates need the photographic realism without the skin-and-pores
 * language, which would only invite the model to put a person in the frame.
 */
const PLACE_QUALITY =
  "an authentic unretouched photograph of a real place, not a render: surfaces show genuine wear, dust, " +
  "scuffs, fingerprints and uneven ageing; materials read as real wood, metal, fabric and glass with " +
  "their true reflectivity; true-to-life colour rather than a heavy grade, faint sensor noise in the " +
  "shadows, high real-world detail";

/**
 * The world half of realism, for renders that have a person in them.
 *
 * The person and the place fail differently and the fix for one does nothing
 * for the other. A model given a flawless description of skin will still set
 * that skin in a showroom: furniture that matches, walls with no marks, no
 * cables, nothing out of place, nothing that anyone actually lives with. That
 * emptiness is as strong an AI tell as plastic skin, and it is the half this
 * compiler used to leave to whatever the storyboard happened to write.
 *
 * What makes a room read as real is evidence of use — the specific,
 * unphotogenic objects nobody would put in a set: a radiator, a plug socket
 * with something charging, a bin, laundry, a mug that does not match, marks on
 * the paint where a chair backs into it.
 */
const WORLD_REALISM =
  "The place is real and lived in, not a set: paint and plaster carry marks, scuffs and small " +
  "repairs; skirting, door frames and switches show wear at the height hands and feet reach them; " +
  "surfaces hold the ordinary clutter of use — cables and a charger, a bin, a mug that does not " +
  "match, post, laundry, something half-finished — arranged the way things actually land rather " +
  "than styled; furniture and fittings are mismatched and of different ages, none of it a matching " +
  "set; textiles are creased and sat-in; floors show traffic. Light behaves physically: it comes " +
  "from the sources visible in the frame, falls off with distance, bounces warm off nearby " +
  "surfaces and leaves real shadows with soft edges. Depth is optical, not layered — the " +
  "background sits at a believable distance and defocuses gradually";

/**
 * The AI tells, named so they can be excluded.
 *
 * Separate from a creator's own drift guards because these are about *medium*,
 * not identity: they are the artefacts that make a technically correct render
 * still look synthetic.
 */
const AI_TELL_NEGATIVE =
  "3D render, CGI, video game character, digital painting, illustration, airbrushed, beauty filter, " +
  "skin smoothing, waxy skin, poreless flawless complexion, perfectly symmetrical face, " +
  "glossy artificial highlights, blown-out highlights, HDR look, oversaturated colour, over-sharpened, " +
  "doll-like eyes, uncanny mannequin look, stock-photo styling, magazine retouching, " +
  // Realism prompting overshoots in one specific direction: ask for
  // imperfection and a model will scatter moles across every visible surface.
  // Which marks this person has is the identity block's business, not the
  // quality block's.
  "extra moles or blemishes beyond those in the subject identity, heavy freckling, spotted or speckled " +
  "skin, acne, spots scattered across the chest, shoulders, arms or neck, blotchy or damaged skin, " +
  "unflattering harsh overhead light, oily shiny skin, sweaty skin, wide-angle facial distortion, stretched or elongated features, arms reaching toward the lens, grimacing or strained expression";

/**
 * The tells a *place* gives off, which are not the ones a person gives off.
 *
 * A showroom interior behind a perfectly rendered face is still an obviously
 * generated image, and naming these is the only thing that removes them.
 *
 * Deliberately NOT part of the base negative. The identity sheet is shot in an
 * intentionally bare white room, so forbidding "unnaturally clean and empty
 * surfaces" there would have the prompt arguing with itself — the compiler
 * would be asking for an empty room and refusing one in the same breath. These
 * apply only where a real location is being rendered.
 */
const PLACE_TELL_NEGATIVE =
  "showroom or display-home interior, staged or styled set, catalogue furniture, everything matching, " +
  "unnaturally clean and empty surfaces, no clutter anywhere, symmetrical set dressing, generic stock " +
  "interior, architectural visualisation, CGI architecture, impossible or invented architecture, " +
  "floating or unsupported furniture, sourceless ambient light, background that ends at the frame edge";

/**
 * Optical and format language, applied to every render.
 *
 * Generic prompts produce generic images: without a stated lens, format and
 * light quality the model averages toward flat, evenly-lit stock photography.
 * Naming a focal length, an aperture behaviour and a capture medium is what
 * makes an image read as *photographed* rather than *generated* — these are the
 * cues that carry depth, falloff and grain.
 */
const CINEMATIC_GRAMMAR =
  "shot on a full-frame cinema camera with a fast prime lens, shallow depth of field with the " +
  "subject sharp and the background falling off softly, natural optical bokeh, gentle highlight " +
  "roll-off and rich retained shadow detail, subtle anamorphic lens character, fine 35mm film grain";

/**
 * Composition guidance. Kept separate from the shot grammar because it applies
 * whatever the framing is, and because it is the difference between a subject
 * centred like a passport photo and one placed like a frame from a film.
 */
const COMPOSITION_GRAMMAR =
  "deliberate cinematic composition with the subject off-centre on a third, clear foreground, " +
  "midground and background separation, layered depth, motivated light sources visible or implied " +
  "in frame, negative space used intentionally";

/**
 * The phone-camera counterpart to CINEMATIC_GRAMMAR, and the reason it exists.
 *
 * A cinema look is the wrong target for social content. Real posts are shot on
 * a front-facing phone camera: a wide lens close to the face, deep focus with
 * no bokeh at all, harsh or mixed available light with clipped windows, mild
 * sharpening and compression from the app. Those "flaws" are precisely the
 * signal a viewer reads as *filmed*. Asking for shallow depth of field and film
 * grain instead produces a technically lovely image that everyone scrolls past
 * as AI.
 */
const PHONE_GRAMMAR =
  "this image is what a modern smartphone camera sees: a normal phone lens at a comfortable distance " +
  "with natural undistorted facial proportions, everything from the subject to the background " +
  "acceptably sharp with no artificial background blur, soft even available light, gentle contrast " +
  "with detail held in both the highlights and the shadows, straight-out-of-camera colour with no grade";

/**
 * Composition for the phone look: casual, imperfect, unstaged.
 *
 * Phrased as where the *viewer* is rather than what the subject is holding. An
 * earlier version said "as if the subject set the phone down or holds it
 * themselves" and the model did the obvious thing: it rendered a phone, on a
 * mount, in the middle of the frame. The camera is the point of view, never an
 * object in the picture.
 *
 * The grammar above also used to ask for phone-style sharpening and clipped
 * windows while the AVOID list forbade over-sharpening and blown highlights —
 * the prompt argued with itself, and the model split the difference into a
 * harsh, over-processed, greasy-looking image. Soft even light is what the
 * reference footage actually has.
 */
/**
 * Casual framing, with the one thing casual framing still gets right.
 *
 * "Imperfectly composed" was doing real damage on its own. Asked for an
 * off-level, unplanned frame at close range, the model delivered exactly that
 * and cropped the top of the head off — the crown cut by the frame edge, the
 * face jammed into a corner, the body filling the rest. Nobody posts that shot;
 * they retake it. The imperfection worth having is a frame that is slightly
 * off-level and un-art-directed, not one that loses the subject's head.
 *
 * So the looseness is kept and bounded: the whole head stays in frame with air
 * above it, and the eyes sit high in the frame the way they do when a person
 * holds a phone up at their own eye level.
 */
const PHONE_COMPOSITION =
  "casual framing from eye level at arm's length, the whole head inside the frame with a hand's " +
  "width above the hair — never cropped by the top edge — and the eyes around the upper third; the " +
  "frame slightly off-level but not mis-aimed; surroundings ordinary and untidied";

const BASE_NEGATIVE =
  // First, because it is the one that ruins an otherwise usable frame: a
  // close shot asked to be casually framed comes back with the crown of the
  // head sliced off by the top edge.
  "the top of the head cropped by the frame edge, forehead or hair cut off, no headroom, " +
  "face pressed into the frame edge, " +
  "different person, face swap, altered facial structure, inconsistent facial features, " +
  "changed skin tone, changed hair colour or length, deformed hands, extra fingers, extra limbs, " +
  "deformed anatomy, plastic skin, oversmoothed skin, text, watermark, logo, signature, " +
  // The camera is a point of view, not a prop. Naming a capture device in the
  // prompt is otherwise an open invitation to draw one.
  "a phone, camera, tripod, gimbal, selfie stick, phone stand, phone mount or ring light visible in " +
  "the frame, a phone propped up or resting screen-out, anyone filming or being filmed on a visible " +
  "device, a second camera";

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Segments are templated as `LABEL: {value}.` but authored values often already
 * end in a period. Strip it so prompts don't accumulate `..`.
 *
 * `max` bounds the authored fields — a creator's identity block and a scene's
 * spec are both model-written and occasionally run long. The image adapter
 * truncates at 5000 characters from the end, which would quietly remove the
 * AVOID block and the consistency key: the two segments that hold identity
 * together. Trimming the variable input instead keeps the fixed grammar whole,
 * and trimming at a word boundary keeps the trimmed field readable.
 */
function sentence(value: string, max = 0): string {
  const cleaned = clean(value).replace(/[.\s]+$/, "");
  if (max <= 0 || cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[,;\s]+$/, "");
}

/**
 * Per-field character budgets. Generous enough that a well-written field is
 * never touched; `withinLimit` tightens them further if a particular creator or
 * scene still overruns.
 */
const FIELD = {
  canonical: 900,
  trait: 260,
  negative: 400,
  action: 320,
  short: 200,
  environment: 420,
  lighting: 320,
  style: 260,
} as const;

/**
 * The image prompt ceiling, with headroom.
 *
 * The adapter truncates from the END, which would silently discard whichever
 * segments come last — the AVOID block and the consistency key, the two that
 * hold identity together across renders. So the compiler owns the budget
 * instead: fixed grammar is never trimmed, and the authored fields give way
 * proportionally until the whole prompt fits.
 *
 * This was 4800 because one compiler fed two models and the budget had to
 * satisfy the smaller ceiling of the two. With a single model there is room for
 * the realism blocks to be as specific as they now are — previously the figure,
 * the skin and the world were competing for the same 4800 characters and the
 * scene description was the one that lost.
 *
 * It must stay below the image adapter's `MODEL_PROMPT_CHARS` — the model
 * refuses to generate above 5000 characters. That relationship was broken once
 * and cost the product its core promise: this budget was raised to 9000 while
 * the adapter cut every prompt at 5000, so a third of every scene prompt — the
 * skin statement, the entire AVOID list, the consistency key — was discarded
 * before it reached the model. Renders drifted in eye colour and skin, and two
 * "fixes" to blemishes changed text that was never being sent.
 *
 * Raising it back to 9000 was the wrong correction, made on a probe that
 * submitted long prompts and read the 200 from `createTask` as acceptance. The
 * model rejects them when the task *runs*, so the only thing that changed was
 * where the failure landed: renders failed outright instead of quietly losing
 * their guards. The adapter now refuses rather than trims, so a budget above
 * the ceiling fails loudly at the boundary instead of degrading every image.
 *
 * 50 characters of headroom. It used to be 200, from when the squeeze only
 * converged toward a target and could overshoot it; `dropTrailingBlocks` now
 * guarantees the result is at or under the limit, so the other 150 were being
 * left unspent on a prompt that was dropping whole instructions off its end.
 */
export const IMAGE_PROMPT_LIMIT = 4950;

function withinLimit(build: (scale: number) => string): string {
  const full = build(1);
  if (full.length <= IMAGE_PROMPT_LIMIT) return full;

  /**
   * Search for the scale, rather than stepping toward it.
   *
   * The previous version multiplied the scale by `LIMIT / length` each pass,
   * which is the right correction only if the whole prompt were authored text.
   * Most of it is not: roughly two-thirds is fixed grammar that does not move.
   * A prompt 10% over budget therefore needs the authored third cut by about a
   * third, not by a tenth — so every pass under-corrected, six passes still
   * landed over the limit, and `dropTrailingBlocks` then threw away whole
   * instructions to make up the difference. That is how the lighting, mood and
   * style blocks were disappearing from scenes that were only a few hundred
   * characters too long.
   *
   * A bisection makes no assumption about which parts scale. Twelve builds of
   * a string cost nothing next to the render they are describing, and the
   * result is the largest scale that actually fits.
   */
  let low = 0;
  let high = 1;
  let best: string | null = null;
  for (let pass = 0; pass < 12; pass += 1) {
    const mid = (low + high) / 2;
    const candidate = build(mid);
    if (candidate.length <= IMAGE_PROMPT_LIMIT) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }
  // Nothing fits even with the authored fields at zero: the fixed grammar alone
  // has outgrown the budget, which no amount of scaling can fix.
  return best ?? dropTrailingBlocks(build(0));
}

/**
 * The last resort, and it drops whole instructions rather than cutting one open.
 *
 * This was `slice(0, IMAGE_PROMPT_LIMIT)` — the exact behaviour the compiler
 * exists to prevent the adapter from doing. On a scene carrying both a location
 * reference and a continuity frame it left the prompt ending mid-word:
 * "QUALITY: an authentic unretouched photograph of an attractive real per",
 * with the composition block gone entirely. A half-sentence is worse than a
 * missing one — the model reads it and acts on the fragment.
 *
 * Blocks are separated by blank lines and ordered most-important-first, so
 * dropping from the end sheds the least valuable instruction still standing.
 * That ordering is load-bearing and was not free: with the photographic
 * grammar sitting last, a prompt sixty characters over budget shed the whole
 * 525-character block to get under, and every located scene lost the
 * instruction that makes it look like a photograph rather than a render.
 * Reaching here at all means the fixed grammar has outgrown the budget, which
 * is a bug in the grammar; this only decides how it fails.
 */
function dropTrailingBlocks(prompt: string): string {
  const blocks = prompt.split("\n\n");
  while (blocks.length > 1 && blocks.join("\n\n").length > IMAGE_PROMPT_LIMIT) {
    blocks.pop();
  }
  const out = blocks.join("\n\n");
  // A single block over the limit cannot be salvaged by dropping; cut it, but
  // at a word boundary so it at least ends on a whole word.
  return out.length > IMAGE_PROMPT_LIMIT ? sentence(out, IMAGE_PROMPT_LIMIT) : out;
}

function joinSegments(segments: Array<string | undefined | null>): string {
  return segments
    .map((segment) => (segment ? clean(segment) : ""))
    .filter((segment) => segment.length > 0)
    .join("\n\n");
}

/**
 * Strip the recording device out of authored scene text.
 *
 * The storyboard writer is told not to put it there, but a storyboard written
 * before that rule — or an operator typing "phone propped on the shelf" into
 * the shot editor — still carries it, and the compiler faithfully passes it to
 * the model. The result argues with itself: the ACTION asks for a phone in
 * frame while AVOID forbids one, and the positive instruction is the one that
 * wins. A shot supposedly filmed on a phone that shows a phone filming means
 * there are two phones, which is exactly as odd as it sounds.
 *
 * Deliberately narrow. It removes a clause only when the clause names a
 * capture device AND says it is set up to record — so "scrolling her phone" or
 * "a phone face-down on the counter" survive untouched, because a phone the
 * subject is using is part of the story rather than the rig filming it.
 */
const CAPTURE_RIG =
  // The optional leading preposition matters: without it, removing the clause
  // out of "with a ring light aimed at her" leaves a dangling "with a ,".
  /(?:\b(?:with|using|and|beside|behind|next to|in front of)\s+(?:a|an|the)\s+)?\b(?:phone|camera|tripod|gimbal|ring ?light|selfie stick)\b[^,.;]*\b(?:propped|mounted|balanced|perched|set up|resting against|leaning against|on a tripod|on a stand|filming|recording|rolling|aimed|pointed|capturing)\b[^,.;]*/gi;

export function withoutCaptureRig(text: string): string {
  if (!text) return text;
  return text
    .replace(CAPTURE_RIG, "")
    // Tidy the punctuation the removed clause leaves behind.
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s*,\s*,/g, ",")
    .replace(/(^|[.;])\s*,\s*/g, "$1 ")
    .replace(/\s*,\s*([.;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,;\s]+/, "");
}

/**
 * Take the framing out of scene text destined for the *video* model.
 *
 * The keyframe already is the framing. It was rendered, looked at and approved,
 * and the clip is supposed to open on it. Describing the framing again in the
 * video prompt does not reinforce that — it licenses a change, and the model
 * takes the licence: the words are unambiguous and the image is only an image.
 *
 * Caught on a two-shot render. The storyboard wrote scene two's environment as
 * "same kitchen counter, closer in now so the mug and cereal box blur out of
 * focus behind her", which is a perfectly good note to the person composing the
 * still. It reached the video model as part of the setting, and the clip opened
 * on a tight close-up of a face where the approved still was a medium shot of
 * someone standing at a counter — a shot nobody had approved, in a project
 * whose whole point is that every shot is approved.
 *
 * Whole clauses go, not words, so what is left still reads as English. Applied
 * only on the video side: in an image prompt this language is doing its job.
 */
const FRAMING_CLAUSE =
  /(?:^|,)\s*[^,.;]*\b(?:closer in|closer now|tighter|wider|pulled? back|zoom(?:ed|ing)? (?:in|out)|framing|framed|in frame|out of frame|edge of (?:the )?frame|fills? the frame|out of focus|shallow depth)\b[^,.;]*/gi;

export function withoutFraming(text: string): string {
  if (!text) return text;
  const stripped = text
    .replace(FRAMING_CLAUSE, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s*,\s*,/g, ",")
    .replace(/(^|[.;])\s*,\s*/g, "$1 ")
    .replace(/\s*,\s*([.;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,;\s]+/, "");
  // If the clause was the whole description, keep the original: a setting line
  // that says nothing is worse than one that says a little too much.
  return stripped.length < 6 ? text : stripped;
}

/** Replace the creator-agnostic token with the neutral subject noun. */
export function substituteSubject(text: string): string {
  // We intentionally substitute a *generic* noun, not the creator's name: the
  // identity block above already fixes who this is, and a name would make the
  // model reach for a celebrity likeness.
  return text.replaceAll(SUBJECT_TOKEN, "the subject");
}

/** Human-readable form for the storyboard UI. */
export function substituteSubjectWithName(text: string, name: string): string {
  return text.replaceAll(SUBJECT_TOKEN, name);
}

// ---------------------------------------------------------------------------
// Identity segment
// ---------------------------------------------------------------------------

/**
 * The locked block, emitted verbatim at the top of every prompt. This is the
 * single highest-leverage piece of the whole system: the same words, in the
 * same order, in every request.
 */
/**
 * True when the operator asked for NO skin mark of any kind.
 *
 * Checked against every mark, not just one: an operator who asked for a beauty
 * mark and got a blanket "skin completely clear, no beauty spots" back would
 * have the prompt contradicting itself in two adjacent lines, which is the
 * failure mode this whole file keeps having to design around.
 */
export function wantsClearSkin(creator: Creator): boolean {
  const asked = `${creator.appearanceNotes ?? ""} ${JSON.stringify(creator.look ?? {})}`.toLowerCase();
  return !/freckle|mole|beauty spot|beauty mark|scar|birthmark|blemish/.test(asked);
}

export function identitySegment(creator: Creator, scale = 1, plainly = false): string {
  const { identity } = creator;
  /**
   * Identity gives way last, and never all the way.
   *
   * `withinLimit` scales every authored field by the same factor, which sounds
   * fair and is not: the scene's prose can lose half its words and still read
   * as the same shot, while the identity paragraph loses the person. Measured
   * on a real two-scene render, the squeeze cut the canonical description to
   * "A woman in her late twenties with a striking, beautiful face and a curvy."
   * — stopping four words before "vivid green eyes". The model was never told
   * the eye colour, invented one per scene, and the operator saw green eyes in
   * shot one and brown in shot two.
   *
   * A floor keeps enough of the description to carry the colours and the
   * asymmetries no matter how tight the budget gets. The scene prose absorbs
   * the difference, which is the right place for it to land.
   */
  const cap = (budget: number) => Math.round(budget * Math.max(scale, IDENTITY_SCALE_FLOOR));
  /**
   * The summary is the one identity field that may still be squeezed freely.
   *
   * `canonical` is a paragraph that restates the others — the same hair, the
   * same skin, the same build, in shorter words — so protecting it too would
   * spend 450 characters buying nothing, on the prompt that was already losing
   * its camera and quality blocks off the end. The specific fields below carry
   * the detail, and the eye colour is restated on its own line, so what is lost
   * here is only the second telling.
   */
  const summary = (budget: number) => Math.round(budget * scale);
  // The retry path: same person, plainer words. Only the intensifiers go —
  // the proportions themselves are what make it the same creator.
  const body = plainly ? soften(identity.bodyType) : identity.bodyType;
  return joinSegments([
    `SUBJECT IDENTITY (must be preserved exactly): ${sentence(identity.canonical, summary(FIELD.canonical))}.`,
    // Hair is identity, not decorative scene detail. `withinLimit` may squeeze
    // authored fields hard on a long scene prompt; allowing that squeeze to
    // reduce "just past shoulder length, off-centre part, loose wave" to
    // "dark hair, worn just" made every keyframe invent its own haircut. Keep
    // this one compact field intact and trim less important scene prose first.
    `Face: ${sentence(identity.face, cap(FIELD.trait))}. Hair: ${sentence(identity.hair)}. ` +
      `Skin: ${sentence(identity.skinTone, cap(FIELD.trait))}.` +
      (identity.distinguishingFeatures.trim()
        ? ` Distinguishing features: ${sentence(identity.distinguishingFeatures, cap(FIELD.trait))}.`
        : ""),
    // Its own segment, and stated as a requirement rather than listed among
    // four other traits. Buried mid-sentence as "Build: ..." it was reliably
    // flattened: a brief asking for a pronounced figure came back average,
    // because one clause inside a long paragraph carries almost no weight
    // against several hundred words of camera and quality grammar.
    plainly
      ? `BUILD: ${sentence(body, cap(FIELD.trait))}.`
      : `BUILD AND FIGURE (render exactly as described, do not slim down or average out): ` +
        `${sentence(body, cap(FIELD.trait))}.`,
    // Age gets the same treatment as the figure, for the same reason. A live
    // 30-second render came back with a creator written as "late twenties to
    // early thirties" looking closer to forty: the phrase was sitting in the
    // opening clause of a 600-character paragraph, where it carries about as
    // much weight as it did when the build was buried there.
    ageOf(identity.canonical),
    // And so does the eye colour, which is the single most visible thing a
    // render can get wrong between two shots of the same person. Uncapped:
    // it is four words, and it is the four words that were being lost.
    eyesOf(identity),
  ]);
}

/** How far the identity description may be squeezed, and no further. */
const IDENTITY_SCALE_FLOOR = 0.42;

/**
 * Restate the eye colour on its own, where nothing can trim it away.
 *
 * The colour is written into the identity prose — "vivid green eyes set beneath
 * slightly arched brows" — and prose is exactly what the budget squeeze eats.
 * Pulled out here it costs about forty characters and is immune, the same
 * treatment the age and the build already get and for the same reason: a fact
 * that must survive every render cannot live in the middle of a paragraph that
 * is allowed to shrink.
 *
 * Read from the description rather than stored as a field, so it works for
 * every creator that already exists without a migration. Returns "" when no
 * colour can be found, which costs nothing — the prose still says it.
 */
function eyesOf(identity: Creator["identity"]): string {
  const shades = "pale|light|dark|deep|vivid|bright|warm|cool|piercing|striking";
  const colours = "amber|blue|brown|green|grey|gray|hazel|black|violet";
  const text = `${identity.canonical} ${identity.face}`;
  const described =
    // "vivid green eyes", "dark brown eyes"
    // Up to two words may sit between the colour and the noun — "dark brown
    // almond eyes", "wide-set green eyes" — and one creator in the sample set
    // was written exactly that way and matched nothing without this.
    new RegExp(
      `\\b(?:(${shades})\\s+)?(${colours})(?:[-\\s](${colours}))?\\s+(?:\\w+[-\\s]){0,2}eyes?\\b`,
      "i",
    ).exec(text) ??
    // "eyes are almond-shaped and green", "her eyes, a deep brown"
    new RegExp(`\\beyes?\\b[^.]{0,40}?\\b(?:(${shades})\\s+)?(${colours})\\b`, "i").exec(text);
  if (!described) return "";

  const words = [described[1], described[2], described[3]].filter(Boolean).join(" ");
  return `EYES: ${words.toLowerCase()} — this exact eye colour in every shot, never altered.`;
}

/**
 * Pull the age out of the canonical description and restate it.
 *
 * Reads rather than stores, because the age lives in prose the identity writer
 * produced and there is no separate field for it — adding one would mean
 * rewriting every existing creator.
 */
function ageOf(canonical: string): string {
  const match = canonical.match(
    /\b(?:in (?:her|his|their) |appears? )?((?:early|mid|late)[- ]?(?:twenties|thirties|forties|fifties|sixties)(?:\s+to\s+(?:early|mid|late)[- ]?(?:twenties|thirties|forties|fifties|sixties))?)/i,
  );
  if (match) {
    return `AGE: ${match[1]} — render this age exactly, neither younger nor older.`;
  }
  const years = canonical.match(/\b(\d{2})[- ]year[- ]old\b/i);
  return years ? `AGE: ${years[1]} years old — render this age exactly.` : "";
}

/**
 * Strip the amplifiers a content filter reacts to, keeping the shape.
 *
 * "Very large heavy bust" and "full bust" describe the same body; only one of
 * them reliably gets a close-up refused. Used solely on the retry, so a normal
 * render keeps the emphasis that makes a figure survive a long prompt.
 */
function soften(text: string): string {
  return text
    .replace(/\b(very|extremely|dramatically|exceptionally)\s+/gi, "")
    .replace(/\bheavy\b/gi, "full")
    .replace(/\bhuge\b/gi, "full")
    .replace(/\blarge\b/gi, "full")
    .replace(/\bsexy\b/gi, "striking")
    .replace(/\bbombshell\b/gi, "striking")
    .replace(/\bcleavage\b/gi, "neckline")
    // Several of the substitutions above land on the same word, so "very large
    // heavy bust" collapsed to "full full bust".
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The creator's own drift guards are never squeezed below this many characters.
 *
 * Enough for the leading items — the face, the jawline, the eye colour — which
 * are the ones that decide whether two shots show the same person.
 */
const IDENTITY_NEGATIVE_FLOOR = 220;

/** Characters each generic negative list gets at full scale. */
const GENERIC_NEGATIVE_BUDGET = 320;

export function negativeSegment(
  creator: Creator,
  scale = 1,
  /**
   * Whether this render puts the subject in a real location. False for the
   * identity sheet, which is shot in a deliberately bare white room — the place
   * tells would contradict it.
   */
  inLocation = false,
): string {
  const parts = [
    // The two lists specific to THIS person come first, and in this order.
    //
    // This one runs to a hundred items, and a prohibition near the end of it is
    // a prohibition the model has stopped reading. The generic tells below are
    // about looking synthetic; these two are about being someone else, which is
    // the failure this whole pipeline exists to prevent.
    unrequestedMarks(creator),
    // Never scaled to nothing. The creator's own guards open with the drift
    // that matters — "different face, altered jawline, changed eye colour" —
    // and when this sat last and took the full squeeze, a 4800-character budget
    // erased the eye-colour guard entirely while keeping generic advice about
    // showroom lighting. A floor keeps the leading items whatever the budget.
    sentence(
      creator.identity.negative,
      Math.max(IDENTITY_NEGATIVE_FLOOR, Math.round(FIELD.negative * scale)),
    ),
    /**
     * The generic lists give way first.
     *
     * They are the lowest value per character in the prompt. A negation buried
     * in a hundred-item list barely registers — that lesson has been re-learned
     * here on blemishes, on the phone in frame and on the wardrobe reference,
     * and every time the fix was a positive statement rather than a longer
     * AVOID. Meanwhile the positive blocks these were competing with — the
     * photograph-not-render language, the light integration — were being cut
     * off the end of the prompt entirely. So under budget pressure these shrink
     * and those survive.
     */
    sentence(BASE_NEGATIVE, Math.round(GENERIC_NEGATIVE_BUDGET * scale)),
    sentence(AI_TELL_NEGATIVE, Math.round(GENERIC_NEGATIVE_BUDGET * scale)),
    inLocation ? sentence(PLACE_TELL_NEGATIVE, Math.round(GENERIC_NEGATIVE_BUDGET * scale)) : "",
  ].filter(Boolean);
  return `AVOID: ${parts.join(", ")}`;
}

/**
 * Forbid the marks this creator was never given.
 *
 * Image models add freckles to almost any fair-skinned face unprompted, and
 * every operator who did not ask for them reads it as the tool ignoring them.
 * Describing the skin as clear is not enough — the only thing that reliably
 * removes a feature is naming it in the negative. So each mark is forbidden
 * unless the creator's own identity actually mentions it, which keeps this from
 * fighting a creator who *was* given freckles on purpose.
 */
function unrequestedMarks(creator: Creator): string {
  // The OPERATOR's own words, not the identity block written from them.
  //
  // This used to read the identity block, which meant a writer that invented
  // "a small mole under the right eye" had, by inventing it, also granted
  // itself permission to render it forever. The person who gets to ask for a
  // mole is the person making the creator.
  const asked = [creator.appearanceNotes ?? "", JSON.stringify(creator.look ?? {})]
    .join(" ")
    .toLowerCase();

  const marks: Array<[string, string]> = [
    ["freckle", "freckles"],
    ["mole", "moles"],
    ["beauty spot", "beauty spots"],
    ["beauty mark", "beauty marks"],
    ["scar", "scars"],
    ["birthmark", "birthmarks"],
    ["blemish", "blemishes, pimples, spots on the face"],
  ];

  const unwanted = marks
    .filter(([needle]) => !asked.includes(needle))
    .map(([, phrase]) => phrase);

  return unwanted.length > 0 ? unwanted.join(", ") : "";
}

// ---------------------------------------------------------------------------
// Identity sheet prompts
// ---------------------------------------------------------------------------

/**
 * Prompt for one canonical angle of a creator's identity sheet. Everything
 * except the angle directive is held constant on purpose.
 */
export function compileIdentitySheetPrompt(
  creator: Creator,
  angle: IdentityAngle,
  /**
   * Drop the emphatic figure wording and re-word the identity plainly.
   *
   * The image provider runs its own content filter, and a creator described in
   * the language that actually lands a figure — "very large", "heavy", the
   * amplified build segment — can trip it. The refusal is total: the angle
   * simply does not render, which is a worse outcome for the operator than a
   * slightly less emphatic frame. This is the retry.
   */
  plainly = false,
): string {
  return withinLimit((scale) =>
    joinSegments([
      identitySegment(creator, scale, plainly),
      `SHOT: ${SHOT_GRAMMAR[ANGLE_FRAMING[angle]]}, ${ANGLE_DIRECTIVE[angle]}.`,
      `WARDROBE: ${sentence(creator.identity.wardrobe, Math.round(FIELD.trait * scale))}, real garment with fabric weight, natural creases and everyday wear.`,
      `CONDITIONS: ${SHEET_CONDITIONS}.`,
      `CAMERA: ${PHOTO_CAPTURE}.`,
      `QUALITY: ${GLOBAL_QUALITY}.`,
      wantsClearSkin(creator) ? `SKIN: ${CLEAR_SKIN}.` : "",
      negativeSegment(creator, scale),
      `CONSISTENCY KEY: ${creator.promptSeed}`,
    ]),
  );
}

/**
 * Prompt used to invent a brand-new creator who has no reference photos. This
 * is the only text-to-image path in the app; once it produces a first frame,
 * every subsequent render is image-to-image against it.
 */
export function compileBootstrapPrompt(creator: Creator): string {
  return withinLimit((scale) =>
    joinSegments([
      identitySegment(creator, scale),
      `SHOT: ${SHOT_GRAMMAR.medium_close_up}, ${ANGLE_DIRECTIVE.front}.`,
      `WARDROBE: ${sentence(creator.identity.wardrobe, Math.round(FIELD.trait * scale))}, real garment with fabric weight, natural creases and everyday wear.`,
      `CONDITIONS: ${SHEET_CONDITIONS}.`,
      `CAMERA: ${PHOTO_CAPTURE}.`,
      `QUALITY: ${GLOBAL_QUALITY}.`,
      wantsClearSkin(creator) ? `SKIN: ${CLEAR_SKIN}.` : "",
      negativeSegment(creator, scale),
      `CONSISTENCY KEY: ${creator.promptSeed}`,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Scene prompts
// ---------------------------------------------------------------------------

/** The still-frame prompt for a scene. */
/**
 * Prompt for a location plate: the room, empty, with nobody in it.
 *
 * "No people" is the entire point and is stated several ways, because a model
 * given a room description will cheerfully populate it. A plate with a stranger
 * standing in it becomes a reference that fights the creator's identity kit on
 * every shot it is attached to.
 *
 * The plate is also shot deliberately neutral — wide, level, even coverage —
 * so it reads as a map of the space rather than a composition. Individual
 * scenes supply their own framing and mood on top of it.
 */
export function compilePlatePrompt(
  description: string,
  styleNotes: string,
  look: CaptureLook = "social",
): string {
  return withinLimit((scale) => joinSegments([
    "Empty establishing wide shot of a location, with NO PEOPLE anywhere in frame.",
    `LOCATION: ${sentence(description, Math.round(FIELD.environment * scale))}.`,
    "Unoccupied and completely empty of any person, figure, silhouette or crowd.",
    "Level eye-height camera, wide angle, even coverage of the space so its layout, depth and scale all read clearly.",
    // A plate is a map of a space, so the things that make it *reusable* are
    // architecture, materials and where the light comes from — the details a
    // later shot has to agree with from a different angle.
    "Architecture, surfaces and materials are clearly described and consistent: floor, walls, ceiling, " +
      "and the furniture or fixtures that define the space, with their finishes and wear visible.",
    "Light sources are visible or clearly implied in frame, establishing where illumination comes from " +
      "and which surfaces it falls on, so later shots from other angles stay lit the same way.",
    "Atmosphere present but restrained: haze, dust or air movement that reveals depth without hiding detail.",
    styleNotes ? `STYLE: ${sentence(styleNotes, Math.round(FIELD.style * scale))}.` : "",
    look === "social"
      ? `CAMERA: ${PHONE_GRAMMAR}, everything in focus so the whole space stays legible.`
      : `CAMERA: ${CINEMATIC_GRAMMAR}, deep focus so the whole space stays legible.`,
    `QUALITY: ${PLACE_QUALITY}.`,
    `NEGATIVE: people, person, human, figure, silhouette, crowd, hands, face, text, watermark, logo, ${AI_TELL_NEGATIVE}.`,
  ]));
}

/**
 * Prompt for a prop plate: one object, isolated, from a neutral angle.
 */
export function compilePropPlatePrompt(description: string, styleNotes: string): string {
  return joinSegments([
    "Product-style reference photograph of a single object, centred in frame, NO PEOPLE.",
    `OBJECT: ${sentence(description, FIELD.environment)}.`,
    "Plain dark neutral background, clean even studio lighting, object fully visible and in sharp focus.",
    styleNotes ? `STYLE: ${sentence(styleNotes, FIELD.style)}.` : "",
    `QUALITY: ${PLACE_QUALITY}.`,
    `NEGATIVE: people, person, hands, face, clutter, text, watermark, ${AI_TELL_NEGATIVE}.`,
  ]);
}

/**
 * Resolve "charcoal or deep-burgundy" down to "charcoal".
 *
 * A creator's default wardrobe is emitted into every scene that does not name
 * its own clothing, so an alternative left in that text is not a description —
 * it is an instruction to choose, taken independently by each render. Observed:
 * a creator whose stored wardrobe read "a charcoal or deep-burgundy wrap
 * blouse" appeared in charcoal in three shots and burgundy in the fourth.
 *
 * The schema now tells Claude to commit to one option, but creators built
 * before that still carry the alternative, and re-generating an identity block
 * would change the person. So it is resolved here as well, deterministically —
 * always the first option, so the same creator resolves the same way on every
 * render rather than alternating.
 *
 * Deliberately narrow: both sides must be colours or materials, which is the
 * shape a wardrobe alternative actually takes and the only kind that changes
 * what a viewer sees. A first attempt matched any single word on both sides and
 * turned "a denim jacket she wears open or slung over one arm" into "…open over
 * one arm" — that "or" joins two ways of wearing one garment, not two garments,
 * and rewriting it produced mangled prose in place of a consistency win.
 */
const GARMENT_CHOICE = new Set([
  "charcoal", "black", "navy", "grey", "gray", "white", "cream", "ivory", "beige", "tan",
  "camel", "brown", "burgundy", "maroon", "olive", "khaki", "forest", "emerald", "teal",
  "blue", "green", "red", "rust", "pink", "lilac", "purple", "mustard", "gold", "silver",
  "denim", "linen", "cotton", "wool", "cashmere", "silk", "jersey", "leather", "suede",
  "corduroy", "flannel", "velvet", "satin",
]);

function commitToOne(wardrobe: string): string {
  return wardrobe.replace(/\b([\w-]+) or ([\w-]+)\b/g, (match, first: string, second: string) =>
    isGarmentChoice(first) && isGarmentChoice(second) ? first : match,
  );
}

/** A colour or material, possibly compounded — "deep-burgundy", "off-white". */
function isGarmentChoice(word: string): boolean {
  return word
    .toLowerCase()
    .split("-")
    .some((part) => GARMENT_CHOICE.has(part));
}

/**
 * How to use a photograph of a real place, when the operator supplied one.
 *
 * The wording is deliberately blunt. "Match this location" produced a generic
 * invented street that merely rhymed with the photo; "reference image N IS the
 * set, and it is not a mood board — reproduce it exactly" produced the actual
 * street, down to the position of the lanterns. The difference was tested side
 * by side on the same model and the same reference.
 *
 * The two escape hatches both had to be closed by name. Left to itself the
 * model brightens and tidies a dark, cramped, grubby place into somewhere
 * photogenic, which is the moment it stops looking like a real photograph. And
 * a street photo usually has people in it who are not this creator.
 */
function locationSetBlock(slot: number, fromRenderedFrame: boolean): string {
  const shared =
    `LOCATION: REFERENCE IMAGE ${slot} IS THE SET, NOT A MOOD BOARD. This photograph happens in ` +
    `that exact place: same architecture, layout, fittings and signage in the same positions, same ` +
    `light sources, colours and brightness. Copy it — do not brighten, widen, tidy or prettify it, ` +
    `and add nothing that is not in it. ` +
    // The one thing the old separate CONTINUITY paragraph said that this did
    // not. It belongs here, next to the image it is about: a live 30-second
    // test came back with the sky a different colour behind every shot,
    // because "dusk" was being re-interpreted per scene instead of read off
    // the plate every scene shares.
    `Its time of day and weather are facts of this location, identical in every shot.`;

  // Two very different pictures can occupy that slot, and the instruction has
  // to change with them. A stock photograph of a street has strangers in it who
  // are not this creator and must go. An earlier frame from this same shoot has
  // the creator in it, and saying "remove the people" would throw away the one
  // thing making the shots match.
  return fromRenderedFrame
    ? `${shared} It is an earlier frame from this same shoot: the person in it IS this subject, ` +
        `so keep her exactly as she appears there — same face, same hair, same clothes, same light ` +
        `on her. Only the camera moves. Change the framing and the angle as described below and ` +
        `leave the room and her appearance alone.`
    : `${shared} Same camera height and viewpoint. Any people in image ${slot} are NOT part of the ` +
        `set: remove them. The only difference between that image and this one is that the subject ` +
        `now stands in it.`;
}

/**
 * The difference between a person *in* a place and a person *in front of* one.
 *
 * A scene prompt describes the subject and the location as two separate blocks,
 * and a model handed two descriptions renders two things: a correctly lit
 * portrait pasted onto a correctly rendered backdrop. Reported as "the keyframe
 * looks like the creator photo was put on the place", and it is exactly that.
 *
 * What fixes it is not more realism words but naming the physics: the light on
 * the subject comes from sources visible in the frame, it is uneven and
 * mixed-temperature because real light is, it falls off, and — the single most
 * effective line — the subject is not brighter than the room. Studio-lit skin
 * in an unlit street is what the eye reads as fake before it reads anything
 * else.
 */
const LIGHT_INTEGRATION =
  "Subject and place are ONE photograph on ONE exposure: the scene's own lights shape both with " +
  "the same direction, colour and falloff, she is no brighter than her surroundings, her light is " +
  "uneven and she casts a real shadow";

export function compileImagePrompt(
  creator: Creator,
  spec: SceneSpec,
  globalStyle: string,
  look: CaptureLook = "social",
  /**
   * 1-based position of the outfit photo in the attached reference list, or 0
   * when there is none.
   *
   * A boolean was not enough, and the failure was visible in the first live
   * test: told only that "a clothing reference image" existed, the model had no
   * way to know which of the attached images it was, and dressed the subject in
   * whatever the identity anchor happened to be wearing. Naming the position —
   * and explicitly discounting the clothing in the other references — is what
   * makes the upload land.
   */
  wardrobeReferenceIndex = 0,
  /**
   * Re-word the identity in plain language, dropping the emphatic figure
   * wording. For one retry after a content filter refuses the shot outright —
   * the same escape hatch the identity sheet uses, and for the same creators.
   * It changes how the person is described, never who they are.
   */
  plainly = false,
  /**
   * 1-based position of the photograph of the place among the attached
   * references, or 0 when there is none.
   */
  locationReferenceIndex = 0,
  /**
   * Whether that reference is an earlier rendered frame of this location rather
   * than a photograph of it. Changes what the model is told to do with the
   * people in it.
   */
  locationReferenceIsFrame = false,
  /** 1-based positions of the creator's verified seed/anchor photographs. */
  identityReferenceIndices: number[] = [],
  /** One project-wide outfit, resolved before any scene is rendered. */
  lockedWardrobe = "",
  /**
   * 1-based position of scene 1's rendered still. It is not allowed to replace
   * the verified creator reference; it supplies only project-wide appearance
   * continuity that prose cannot encode precisely (hair styling and clothing).
   */
  appearanceContinuityReferenceIndex = 0,
): string {
  // With an outfit photo attached, the creator's *default* wardrobe text is not
  // a fallback — it is a second, different outfit described to the same model
  // in the same breath as "wear the garment in the photo". The scene's own
  // wardrobe still wins when the story genuinely calls for specific clothing.
  const hasWardrobeReference = wardrobeReferenceIndex > 0;
  const wardrobe = hasWardrobeReference
    ? ""
    : commitToOne(lockedWardrobe.trim() || spec.wardrobe.trim() || creator.identity.wardrobe);
  const phone = look === "social";
  return withinLimit((scale) => {
    const cap = (budget: number) => Math.round(budget * scale);
    return joinSegments([
      identitySegment(creator, scale, plainly),
      identityReferenceIndices.length
        ? `IDENTITY GROUND TRUTH: REFERENCE IMAGE${identityReferenceIndices.length === 1 ? "" : "S"} ` +
          `${identityReferenceIndices.join(", ")} ${identityReferenceIndices.length === 1 ? "is" : "are"} the verified creator and the sole authority on the person. ` +
          `Match that exact face, eyes, nose, lips, jaw, skin, hairline and hair. Never average or merge her. ` +
          `Anyone in a location, wardrobe or style reference is NOT the subject.`
        : "",
      /**
       * The identity guards sit with the identity, not at the end of the prompt.
       *
       * They used to be the last three segments, which put the skin statement,
       * every "do not change this" and the consistency key furthest from the
       * description they exist to protect — and first in line to be lost to any
       * budget squeeze. That is precisely what happened when the adapter's cut
       * was below the compiler's budget: the positive "vivid green eyes" was
       * delivered and the negative "changed eye colour" was not, and renders
       * came back with brown eyes in three shots out of four.
       *
       * Adjacency is also how they read as one instruction rather than an
       * afterthought: the model weights earlier content more heavily, and a
       * constraint 8000 characters downstream of the claim it constrains is a
       * constraint in name only.
       */
      wantsClearSkin(creator) ? `SKIN: ${CLEAR_SKIN}.` : "",
      negativeSegment(creator, scale, true),
      `CONSISTENCY KEY: ${creator.promptSeed}`,
      /**
       * Framing sits with framing, and that is also what keeps it.
       *
       * COMPOSITION was the last segment in the prompt and was being dropped
       * outright on every scene that carried a location reference — including
       * the headroom rule, whose absence is what returns a close-up with the
       * crown of the head sliced off by the top edge. It is the same subject
       * as SHOT, so it belongs here rather than eight blocks downstream.
       */
      `SHOT: ${SHOT_GRAMMAR[spec.shotType]}. Subject orientation: ${ANGLE_DIRECTIVE[spec.subjectAngle]}. ` +
        `${phone ? PHONE_COMPOSITION : COMPOSITION_GRAMMAR}.`,
      /**
       * One block, because they were one subject described twice.
       *
       * CAMERA and QUALITY ran to about 1,240 characters between them and
       * overlapped throughout — both specified the light, both specified the
       * colour treatment, and QUALITY re-stated the pores and texture that the
       * SKIN block a few lines above had already demanded. Together they were
       * a quarter of the budget, and QUALITY was past the end of it: on every
       * scene carrying a location reference the model never received it.
       *
       * Merged and de-duplicated, the same instruction fits in 500 and arrives.
       */
      `PHOTOGRAPH: ${phone ? PHONE_GRAMMAR : CINEMATIC_GRAMMAR}. ${HUMAN_REALISM}.`,
      `ACTION: ${sentence(withoutCaptureRig(substituteSubject(spec.action)), cap(FIELD.action))}.`,
      `EXPRESSION: ${sentence(spec.facialExpression, cap(FIELD.short))}. POSE: ${sentence(withoutCaptureRig(spec.pose), cap(FIELD.short))}.`,
      `WARDROBE: ${wardrobe ? `${sentence(wardrobe, lockedWardrobe ? FIELD.trait : cap(FIELD.trait))}, ` : ""}fabric weight and texture clearly readable, natural creases, everyday wear and drape.` +
        (hasWardrobeReference
          ? ` CLOTHING COMES FROM REFERENCE IMAGE ${wardrobeReferenceIndex}. The subject wears that ` +
            `exact garment — same colour, same cut, same neckline, same fabric, same details — fitted ` +
            `to this person and this pose. Take ONLY the garment from image ${wardrobeReferenceIndex} — ` +
            `nothing else about it. If a person is wearing it in that image, that person is NOT the ` +
            `subject: do not take their face, their hair colour, their hair length, their skin tone, ` +
            `their build or their pose from it. Do not take its background or its lighting either. ` +
            `Every physical attribute of the subject comes from the identity above and from the other ` +
            `reference images, whose clothing in turn must NOT appear here.`
          : ""),
      appearanceContinuityReferenceIndex > 0
        ? `APPEARANCE CONTINUITY: REFERENCE IMAGE ${appearanceContinuityReferenceIndex} is scene 1 of ` +
          `this project and rules the styling only. Copy its haircut, length, part, wave and volume, ` +
          `and its complete outfit — every garment, colour, material, cut, neckline, sleeve and ` +
          `accessory — without redesigning, recolouring, adding or removing anything. The identity ` +
          `references above still rule the face, skin and body.`
        : "",
      // The operator's own photograph of the place outranks the written
      // description of it, so it goes first and the description follows as
      // detail rather than as an alternative.
      locationReferenceIndex > 0
        ? locationSetBlock(locationReferenceIndex, locationReferenceIsFrame)
        : "",
      `ENVIRONMENT: ${sentence(withoutCaptureRig(spec.environment), cap(FIELD.environment))}. The space continues beyond the frame edges rather than ending at them.` +
        // WORLD_REALISM argues a real place into existence from words. With a
        // photograph of that place attached it is arguing for something already
        // settled, and the characters are better spent on the guards.
        // Capped, not fixed. It argues a lived-in place into existence from
        // words, which is worth having — but not at the price of the headroom
        // rule that follows it, whose absence returns frames with the top of
        // the head sliced off.
        (locationReferenceIndex > 0 ? "" : ` ${sentence(WORLD_REALISM, cap(FIELD.environment))}.`),
      /**
       * Continuity with the room's own reference render.
       *
       * Every shot in a location is generated against the same empty plate, but
       * that only fixes the geometry — a live 30-second test came back with the
       * sky a different colour behind every shot, because "dusk" was being
       * re-interpreted each time. The time of day has to be stated as a fixed
       * fact of the location rather than a mood for the shot.
       */
      /**
       * Only when there is no photograph of the place.
       *
       * With a location reference attached this block was 262 characters of
       * restatement: the LOCATION block above already demands the same
       * architecture, fittings, light sources, colours and brightness, in more
       * detail and closer to the reference it is talking about. The only fact
       * it added — time of day and weather — has moved up there, where it costs
       * eleven words instead of a paragraph.
       *
       * That paragraph was not free. Both blocks together pushed every located
       * scene against the 4800-character ceiling, and what gave way was the
       * identity description and the tail of the prompt.
       */
      locationReferenceIndex > 0
        ? ""
        : `CONTINUITY: this is one continuous moment. Keep the creator's face, skin, haircut, hair ` +
          `colour and complete outfit identical to every other shot in this project.`,
      `LIGHTING: ${sentence(spec.lighting, cap(FIELD.lighting))}. ${LIGHT_INTEGRATION}.`,
      `MOOD: ${sentence(spec.mood, cap(FIELD.short))}. The framing, light and the subject's body language should all carry this, not the expression alone.`,
      `STYLE: ${sentence([spec.styleNotes, globalStyle].filter(Boolean).join(", "), cap(FIELD.style))}.`,
    ]);
  });
}

/**
 * The motion prompt handed to the video model.
 *
 * Notably terser than the image prompt, and it does *not* re-describe the
 * subject's appearance: the keyframe already encodes identity, and re-stating
 * it fights the conditioning image rather than reinforcing it.
 */
/**
 * What a video model must not do, stated once.
 *
 * Unlike a still prompt — where negations are risky because the model acts them
 * out — these name *failure modes* rather than content, and video models
 * respond well to them: morphing, flicker and warping are exactly the artefacts
 * that ruin an otherwise usable clip.
 */
const AVOID_MOTION =
  "AVOID: morphing or warping of the face or body, identity drift, changing facial features mid-clip, " +
  "extra or deformed fingers, flickering or strobing artefacts, sudden cuts or jump frames, " +
  "text or captions appearing, distorted background architecture, " +
  // Same rule as the still: the device filming this is the viewer's eye, not a
  // prop in the room, and a clip that reveals one has two cameras in it.
  "a phone, camera, tripod, phone stand or ring light appearing in the frame, " +
  "skin smoothing or beauty-filter cleanup between frames, a rendered or animated look.";

/**
 * Realism has to be restated for motion, because it is lost differently here.
 *
 * A video model given a photographic keyframe will still drift toward rendered
 * output over the clip — it cleans the skin up frame by frame, and it moves the
 * body with an evenness no real person has. Naming the small involuntary
 * motions is what keeps the result reading as footage.
 */
const FOOTAGE_REALISM =
  "The clip must look like real footage of a real person filmed on a real camera. The skin keeps the " +
  "texture, marks and unevenness of the reference image in every frame. Movement carries genuine human " +
  "irregularity — micro-shifts of weight, involuntary small adjustments, uneven blinks, breath visible " +
  "in the shoulders — rather than smooth uniform animation.";

/**
 * How the camera itself behaves, per look.
 *
 * In the phone look the camera is an object someone is holding, and it shows:
 * it breathes, it drifts, it is never quite level. A locked-off move is what
 * makes an otherwise convincing clip read as generated.
 */
const PHONE_MOTION =
  "CAMERA: handheld phone held by the subject or propped nearby — constant faint handheld breathing, " +
  "tiny drifts in framing, never perfectly level or perfectly still, no smooth mechanical camera moves.";

export function compileVideoPrompt(
  spec: SceneSpec,
  globalStyle: string,
  options: {
    dialogue?: string;
    speaking?: boolean;
    /**
     * The scene has a line, but it is narration laid over this shot rather than
     * something the subject says. The words are deliberately not passed on: a
     * video model handed a script animates a mouth saying it.
     */
    voiceover?: boolean;
    look?: CaptureLook;
  } = {},
): string {
  const style = sentence([spec.styleNotes, globalStyle].filter(Boolean).join(", "), FIELD.style);
  const phone = (options.look ?? "social") === "social";
  const cameraLine = phone
    ? PHONE_MOTION
    : `CAMERA: ${CAMERA_GRAMMAR[spec.cameraMove]}, smooth and constant with natural weight, no jitter, ` +
      "no speed ramping, staying on one axis.";

  // A scene with a spoken line is a different shot from a scene without one.
  // Handing the storyboard's motion beat ("strides briskly toward the camera")
  // to a talking scene is what produced clips where the subject charges the
  // lens with a fixed grin and never moves their mouth.
  if (options.speaking) {
    return joinSegments([
      /**
       * What they are saying, not "the reference audio".
       *
       * That phrase was written when the recording was attached to the request
       * and the model performed from it. The recording is no longer sent — the
       * shot is rendered silent and the creator's voice lip-synced on
       * afterwards — so the prompt was pointing at something that is not there,
       * and the model had nothing to pace the performance against. Handing it
       * the actual words gives the delivery a length and a rhythm to act.
       */
      options.dialogue?.trim()
        ? `The subject is speaking directly to the camera, saying: "${sentence(options.dialogue, FIELD.action)}"`
        : "The subject is speaking directly to the camera.",
      "BEGINNING: the subject is already mid-thought as the clip opens — no static pause before they " +
        "start — settling their weight and lifting their chin slightly as the first words land.",
      "MIDDLE: their lips, jaw and cheeks move naturally and precisely in time with every word, with clear " +
        "visible mouth articulation throughout. Their eyebrows and eyes carry the emphasis of the sentence, " +
        "they blink naturally, and their head makes small conversational turns and nods on the beats they " +
        "stress. One relaxed hand gesture rises and falls once with the rhythm of the line.",
      // The tail is where drift appears: once the speech runs out the model
      // invents motion to fill the remaining seconds. Naming the ending gives
      // it something settled to generate instead.
      "END: they finish the last sentence, close their mouth, hold the look at the lens and let a small " +
        "settling breath out, still and composed until the clip ends.",
      // Phrased as what the subject *does*, never as what they must not do.
      // Video models routinely act out the content of a negation.
      /**
       * Movement, described as a quantity rather than a permission.
       *
       * The previous wording planted the feet and left "movement lives in the
       * head, face, shoulders and hands" — which a model reads as a licence to
       * move almost nothing. Frames sampled across a finished clip were close
       * to identical apart from the mouth, which is the "moves like a robot"
       * complaint exactly. Naming continuous, specific motion is what produces
       * it; a person talking is never still.
       */
      "They stay in one spot but they are never still: their weight shifts from one foot to the other, " +
        "their shoulders and torso turn slightly with each point, their head tilts and comes back, and " +
        "their hands stay in motion through the whole line — rising to gesture, opening on an emphasis, " +
        "settling and lifting again — with the small constant adjustments of someone mid-conversation " +
        "rather than someone posing.",
      `SETTING: ${sentence(withoutFraming(withoutCaptureRig(spec.environment)), FIELD.environment)}. ${sentence(spec.lighting, FIELD.lighting)}. ` +
        "Secondary motion continues quietly behind them — drifting air, a flicker in a light source, " +
        "distant movement well out of focus — so the world feels alive rather than frozen.",
      phone
        ? PHONE_MOTION
        : `CAMERA: ${CAMERA_GRAMMAR[spec.cameraMove]}, smooth and unhurried at a constant speed with natural weight. ` +
          "The camera does the moving, not the subject.",
      "The subject's face, hair, body and clothing stay exactly as in the reference image throughout.",
      FOOTAGE_REALISM,
      `MOOD: ${sentence(spec.mood, FIELD.short)}. ${style}`,
      AVOID_MOTION,
    ]);
  }

  return joinSegments([
    `BEGINNING: the shot opens already in motion — ${sentence(withoutFraming(withoutCaptureRig(substituteSubject(spec.motion))), FIELD.action)}.`,
    // Phrased as what the subject does — a model told "not talking" tends to
    // act out talking. The narration is attached afterwards as recorded.
    options.voiceover && !options.speaking
      ? "This shot plays under a separately recorded voice-over: the subject's lips stay softly " +
        "closed and relaxed throughout, their attention on the place around them, the expression " +
        "carried by the eyes and posture."
      : "",
    "MIDDLE: that motion continues at a steady, physically plausible pace, with secondary movement " +
      "layered underneath it — fabric settling, hair shifting, dust or air moving through the light, " +
      "reflections and highlights travelling as the camera changes angle.",
    "END: the movement resolves and settles rather than stopping abruptly, holding a composed final frame.",
    cameraLine,
    "The subject's face, hair, body and clothing must remain exactly as in the source image throughout the clip.",
    FOOTAGE_REALISM,
    `MOOD: ${sentence(spec.mood, FIELD.short)}. ${style}`,
    AVOID_MOTION,
  ]);
}

/**
 * A v3 delivery tag for a scene, derived from its mood.
 *
 * Kept to a short allow-list rather than passing the mood string through: an
 * unrecognised tag is wasted, and a long one risks being read aloud.
 */
export function deliveryTagFor(spec: SceneSpec): string {
  const haystack = `${spec.mood} ${spec.facialExpression}`.toLowerCase();
  for (const [tag, pattern] of DELIVERY_TAGS) {
    if (pattern.test(haystack)) return tag;
  }
  return "warmly";
}

const DELIVERY_TAGS: Array<[string, RegExp]> = [
  ["excited", /excit|electric|energetic|thrill|hyped/],
  ["cheerfully", /happy|joy|bright|playful|fun/],
  ["warmly", /warm|invit|friendly|welcom/],
  ["curiously", /curious|intrigu|wonder/],
  ["calmly", /calm|serene|quiet|relax|peace/],
  ["seriously", /serious|somber|tense|urgent/],
];

// ---------------------------------------------------------------------------
// Reference selection
// ---------------------------------------------------------------------------

/**
 * Upper bound on references per request. Each adapter clamps further to its
 * own model's cap; this only stops the selector building a list that no
 * provider could accept.
 */
// KIE Seedream accepts eight images. Keeping the selector at the same cap as
// the adapter prevents the adapter from silently dropping a referenced slot.
const MAX_REFS = 8;
/**
 * Reserve slots so context refs can never crowd out identity anchors.
 *
 * Five: a scene can carry an outfit photo, a location plate, the previous shot
 * from that same location, a place reference and a style reference. At four,
 * the last of those was silently dropped whenever an operator used all of
 * them — an upload that appears in the form, is stored, and never reaches the
 * model. A creator's own anchors are typically two or three, so five here still
 * leaves the identity side everything it uses.
 */
// One outfit, one location and one style image. The remaining five slots stay
// available for the creator's ground-truth photographs.
const MAX_CONTEXT_REFS = 3;

/**
 * Choose which images to attach to a render, in priority order.
 *
 * Ordering is the point: identity anchors first (the model weights earlier
 * references more heavily), then the sheet shot matching this scene's angle,
 * then background and style references. Angle-matching matters — feeding a
 * frontal portrait as the anchor for a rear shot is what produces the classic
 * "wrong person from behind" failure.
 */
export function selectReferences(options: {
  references: CreatorReference[];
  angle: IdentityAngle;
  /**
   * Location / prop plates for this specific scene. Placed after the identity
   * anchors but ahead of project-wide background and style references: the
   * model weights earlier references more heavily, and *who* the person is
   * matters more than *where* they are standing, while where they are standing
   * matters more than a general mood board.
   */
  plateUrls?: string[];
  /**
   * Outfit photos. First among the context references on purpose: the garment
   * is worn by the subject, so it competes with the identity anchors for the
   * same pixels, and a wardrobe reference the model barely weighted is a
   * wardrobe reference the operator will say was ignored.
   */
  wardrobeRefs?: string[];
  /** Scene 1 of this project, used only to lock hair styling and wardrobe. */
  continuityRefs?: string[];
  backgroundRefs?: string[];
  styleRefs?: string[];
}): string[] {
  const { references, angle } = options;

  const seeds = references.filter((ref) => ref.kind === "seed");
  const anchors = references.filter((ref) => ref.isAnchor);
  const trustedSheetAnchors = anchors.filter((ref) => ref.kind === "sheet");
  const angleMatch = trustedSheetAnchors.filter((ref) => ref.angle === angle);
  const otherSheet = trustedSheetAnchors.filter((ref) => ref.angle !== angle);

  const contextRefs = [
    ...(options.continuityRefs ?? []),
    ...(options.wardrobeRefs ?? []),
    ...(options.plateUrls ?? []),
    ...(options.backgroundRefs ?? []),
    ...(options.styleRefs ?? []),
  ].slice(0, MAX_CONTEXT_REFS);

  const identityBudget = MAX_REFS - contextRefs.length;
  const identityUrls = dedupe([
    // User uploads / the bootstrap seed are the ground truth and must be first.
    // Generated sheet images are excluded unless the operator explicitly marks
    // one as an anchor; an unreviewed sheet was previously able to replace the
    // person differently for every requested scene angle.
    ...anchors.filter((ref) => ref.kind === "seed").map((ref) => ref.remoteUrl),
    ...seeds.map((ref) => ref.remoteUrl),
    ...angleMatch.map((ref) => ref.remoteUrl),
    ...otherSheet.map((ref) => ref.remoteUrl),
  ]).slice(0, Math.max(1, identityBudget));

  return dedupe([...identityUrls, ...contextRefs]).slice(0, MAX_REFS);
}

/** 1-based positions of the creator's ground-truth seed/anchor photographs. */
export function identityReferencePositions(
  selected: string[],
  references: CreatorReference[],
): number[] {
  const groundTruth = new Set(
    references
      .filter((ref) => ref.kind === "seed" || ref.isAnchor)
      .map((ref) => ref.remoteUrl),
  );
  return selected
    .map((url, index) => (groundTruth.has(url) ? index + 1 : 0))
    .filter((index) => index > 0);
}

/**
 * Where the outfit photo ended up in the list `selectReferences` returned.
 *
 * 1-based, or 0 when there is no outfit photo or it was squeezed out by the
 * reference cap. The prompt has to name this position: "the clothing reference
 * image" means nothing to a model handed five images at once, and the first
 * live test came back with the subject wearing the identity anchor's jumper
 * rather than the uploaded dress.
 */
export function wardrobeReferencePosition(
  selected: string[],
  wardrobeRefs: string[] | undefined,
): number {
  return referencePosition(selected, wardrobeRefs);
}

/** 1-based position of the project's scene-1 appearance master, or 0. */
export function appearanceContinuityReferencePosition(
  selected: string[],
  continuityRefs: string[] | undefined,
): number {
  return referencePosition(selected, continuityRefs);
}

/**
 * Where the photo of the place ended up in the attached list.
 *
 * Same reasoning as the wardrobe slot, and the same failure before it existed:
 * a place photo was uploaded, stored, attached to the render — and never
 * pointed at. The model treated it as one more thing to be vaguely influenced
 * by and invented its own street instead. Naming the slot is what turns a
 * reference into an instruction; proven side by side, where the difference
 * between "match this location" and "reference image 2 IS the set" was the
 * difference between a generic alley and the actual one.
 */
export function locationReferencePosition(
  selected: string[],
  backgroundRefs: string[] | undefined,
): number {
  return referencePosition(selected, backgroundRefs);
}

/** 1-based position of the first of `candidates` in `selected`, or 0. */
function referencePosition(selected: string[], candidates: string[] | undefined): number {
  if (!candidates?.length) return 0;
  for (const url of candidates) {
    const index = selected.indexOf(url);
    if (index >= 0) return index + 1;
  }
  return 0;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => Boolean(value))));
}

/** Internals exposed for tests only. */
export const __testingPrompt = { commitToOne };

/**
 * Change the clothes, keep the photograph.
 *
 * Used for the second stage of a wardrobe render, where an already-rendered
 * frame is handed to an editing model along with the outfit reference. The
 * whole value of that frame is what it already got right — the face, the skin
 * texture, the light, the room — so almost every clause here is a "do not".
 *
 * Deliberately says nothing about who the subject is. The identity is not
 * being generated in this pass; it is already in image 1, and describing it
 * again invites the model to re-render a face it was supposed to leave alone.
 */
export function garmentSwapPrompt(): string {
  return (
    "Don't change anything, just change the dress in the first image and make her wear the exact " +
    "same dress from the second image. Keep her face, hair, pose, the room, the framing and the " +
    "lighting exactly as they are. DON'T CHANGE ANYTHING ELSE"
  );
}
