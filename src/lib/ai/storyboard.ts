import {
  parseSceneSpec,
  parseStoryboard,
  sceneSpecSchema,
  storyboardSchema,
  type StoryboardResult,
} from "@/lib/ai/schemas";
import { DEFAULT_CHARS_PER_SECOND } from "@/lib/media/voice-pace";
import { llmProvider } from "@/lib/providers/registry";
import type { Creator, ProjectSettings, SceneSpec } from "@/lib/types";
import { describeVideoStyle } from "@/lib/video-style";

/**
 * Storyboard + script generation.
 *
 * The critical constraint here is that the output must be *creator-agnostic*.
 * Claude is told to refer to the subject only as `{CREATOR}` and is given the
 * creator's persona for tone but explicitly forbidden from describing their
 * appearance. That is what makes character swapping a substitution rather than
 * a regeneration: the scenes, actions, camera work and script survive the swap
 * untouched.
 */

const STORYBOARD_SYSTEM = `You are a short-form social video director and scriptwriter.

Given a creative brief, you produce a shot-by-shot storyboard and the matching voice-over
script for a vertical social video (Instagram Reels / TikTok / YouTube Shorts).

HARD RULES — these make the storyboard reusable across different creators:
1. NEVER describe the presenter's appearance: no age, gender, ethnicity, hair, build,
   face, or clothing that implies a specific person. A separate identity system owns that.
2. ALWAYS refer to the presenter as the literal token {CREATOR}. Not "she", not "he",
   not "the host", not a name. The token appears in "action" and "motion".
3. The "wardrobe" field describes clothing ONLY when the brief calls for something
   specific (a chef's whites, a wetsuit). Otherwise leave it as an empty string so the
   creator's own default wardrobe is used. When it is not empty, use the exact same
   wardrobe text in every scene of the project and fully specify every visible garment:
   one exact colour, material and cut for the top, outer layer and lower-body garment.
   Never write an uncoloured item such as "a pencil skirt"; write "a white wool pencil
   skirt". Never offer alternatives and never silently change any garment between scenes.
4. NEVER put the recording device in the scene. No phone propped on a stack of books, no
   tripod, no ring light, no camera, and nobody filming themselves on a visible handset.
   The camera is the viewer's eye, not an object in the room — a phone in frame means a
   second phone is filming the first, which reads as an obvious mistake. This holds in
   "action", "pose", "motion" and "environment" alike. (A phone the subject is genuinely
   USING as part of the story — reading a message, showing the screen — is fine, so long
   as it is not the thing recording.)

CRAFT RULES:
- Open with a hook in the first 2 seconds. No slow build-ups.
- Vary shot type and camera move between consecutive scenes; never use the same shot
  type twice in a row.
- FILL THE TIME. Each scene's line must take its full duration to say out loud, at about
  2.6 words per second. A 6-second scene needs ~16 words, an 8-second scene ~21, a
  9-second scene ~23. Count them, and write to the number.
  This is the single most important rule here and it fails in one direction: SHORT.
  The clip is rendered at the measured length of the recorded narration, so a line that
  is two seconds light does not leave a pause — it makes the whole video two seconds
  shorter than the operator asked for, and a run of short lines is why a 30-second brief
  came back as 24 seconds of finished video with a silent stretch in the middle of it.
  Do not "leave room". Do not write a five-word line for an eight-second shot. If a beat
  genuinely has nothing more to say, give it a shorter DURATION rather than a short line,
  and give those seconds to a scene that does.
- Scene durations must be within the clip limits given below and must sum EXACTLY to the
  requested total duration. Then check the reverse: read every line aloud in your head at
  2.6 words per second and confirm each one really does last its scene's duration. The sum
  of the SPOKEN lines is what the finished video actually runs to.
- "transcript" is the concatenation of every scene's dialogue in order, as flowing prose.
  It must contain no stage directions and no scene labels.
- Write for the ear, not the page: short sentences, concrete nouns, active verbs.
- Choose "subjectAngle" to match the shot. A shot of the presenter walking away is
  "rear"; a talking-head is "front" or "three_quarter"; a detail of the face is
  "close_up"; a full-figure establishing shot is "full_body".

SPECIFICITY — the difference between a good shot and a generic one:
Every field should name something a camera could actually photograph. "A nice kitchen" is
not a shot; "a narrow galley kitchen, morning light raking across a scratched steel counter"
is. Apply this to all of them:
- "environment": name the surfaces, the light sources and one or two specific objects. What
  is in the foreground? What is behind the subject? Where is the light coming from?
- "lighting": give it a direction, a quality and a colour — "hard low sun from camera left,
  warm, throwing a long shadow across the floor" beats "good lighting".
- "facialExpression" and "pose": describe what the body is *doing*, not the emotion it
  represents. "Eyebrows lifted, leaning in over the counter" beats "excited".
- "styleNotes": name a real photographic look — film stock, lens character, grade — rather
  than adjectives like "cinematic" or "high quality", which every render already gets.
- "motion": describe change over time. What starts, what continues, what settles?
Avoid empty intensifiers — stunning, beautiful, perfect, amazing, epic. They add nothing a
model can render. One concrete detail is worth ten of them.

The target look is a real photograph or a real camera's footage, not a polished render.
Prefer available light with a visible source and honest imperfection — a slightly blown
window behind her, a lamp that colours one side of her face, shade that goes cool — over
flattering, even, sourceless illumination. Set dressing should look lived in and used.

LOCATIONS — this controls whether the piece looks like one place or five:
Give every scene a "locationKey": a lowercase slug naming the PLACE it happens in.
- REUSE the same key for every scene set in the same place. Three shots of one ramen
  counter all get "ramen_counter" — they are three angles on one room, not three rooms.
- Only invent a new key when the story genuinely travels somewhere else.
- A typical short piece should use ONE or TWO locations. Aim to cover a scene list with
  as few keys as the story allows; a new key for every scene is almost always wrong.
- "environment" still describes what THIS shot sees — the corner, the framing, the
  foreground. The key says which room; the text says which part of it.
One empty reference render is made per distinct key and fed into every shot using it, so
reusing keys is what makes consecutive shots cut together as the same space.

TALKING SCENES — read this before writing any scene that has dialogue:
A scene with a spoken line is a scene where {CREATOR} is TALKING TO CAMERA. That is the
shot. Write it as one.
- "shotType" must be "medium", "medium_close_up" or "close_up" — the mouth has to be big
  enough in frame to read. Never "wide", "extreme_wide" or "medium_wide" for a spoken line.
- "subjectAngle" must be "front" or "three_quarter".
- "cameraMove" must be "static", "slow_push_in" or "handheld". The CAMERA moves; the
  presenter does not travel.
- "action", "pose" and "motion" must keep {CREATOR} in one place — standing, seated or
  leaning. Gestures, head turns and weight shifts are good. Walking or running toward the
  lens is NOT: it changes the subject's scale mid-shot and wrecks the speech animation.
- "facialExpression" must leave the mouth free to move. "Warm, animated, mouth relaxed and
  moving as she speaks" is right. A fixed "wide grin" or "beaming smile" is wrong — a
  locked expression fights the spoken performance.
NEVER leave "dialogue" empty in a video with a script. A silent scene is not a breather, it
is a hole: the creator stands there saying nothing while the viewer waits, and the piece
reads as broken. It also produces a clip with no sound at all, which is a different length
of problem when the shots are joined. Every scene in a talking piece carries part of the
line. If a beat feels like it wants a wordless shot, give it the quietest sentence instead.`;

/**
 * The look brief, handed to the storyboard rather than only to the renderer.
 *
 * The renderer can enforce a camera, but it cannot undo a storyboard written
 * for a different medium: "golden hour rim light across a rooftop, slow orbit"
 * is a shot nobody films on a phone, and every field downstream inherits that
 * assumption. Telling the writer what the piece was supposedly filmed on is
 * what keeps the environments, lighting and camera moves reachable.
 */
const PHONE_LOOK_BRIEF = `LOOK: this is filmed on a phone by the presenter themselves — a real
post, not a production. Write shots someone could actually get that way: ordinary rooms, cars,
kitchens, streets and stairwells; whatever light is already there, including bad light; the framing
casual and close, as if the phone is just out of shot. "cameraMove" should stay "static" or
"handheld" almost always. For "styleNotes" name the phone-video look — front camera, no grade,
available light — never film stock, anamorphic lenses or colour grades, which belong to a different
medium and read as fake here.

THE PHONE IS THE CAMERA, NOT A PROP. Never write the recording device into any field. No "phone
propped against a stack of books", no "phone on a tripod", no ring light, no camera in shot, and
nobody holding a phone toward themselves. The viewer is where that device is, so putting it in the
frame means a second phone filming the first — which is what it looks like, and it is instantly
wrong. Describe what is in front of the lens and nothing about what is behind it.`;

const CINEMATIC_LOOK_BRIEF = `LOOK: this is a produced piece shot on cinema glass. Lens character,
shallow focus, deliberate camera moves and a considered grade are all in scope, and "styleNotes"
should name a real film stock, lens and grade.`;

/**
 * The brief for a photo set rather than a video.
 *
 * Same machinery, different output: each "scene" is a finished post, not a beat
 * in a sequence, so they should look like separate photographs of the same
 * person rather than frames from one clip. Dialogue is empty throughout —
 * nothing here is spoken, and a line written into a still is a line that never
 * gets heard.
 */
const PHOTO_BRIEF = `THIS IS A PHOTO SET, NOT A VIDEO. Every scene you write is a finished,
publishable still image, not a beat in a sequence.
- Leave "dialogue" as an empty string for EVERY scene. Nothing is spoken. Leave "transcript"
  as a one-sentence caption for the set as a whole, not a script.
- Vary the shots properly: different framing, different angle, different pose and a different
  moment in each. Two stills that differ only in expression are one usable post, not two.
- "cameraMove" is irrelevant to a still; use "static" everywhere.
- Durations are ignored for a photo set. Give every scene the minimum allowed value.
- These are posts. Each frame should be able to stand on its own in a feed, so compose each
  one deliberately rather than writing coverage of a single moment.`;

/**
 * Aim slightly under the ceiling rather than at it.
 *
 * The model's pacing is not repeatable — the same sentence in the same voice
 * came back at 7.39s, 7.08s and 7.31s — so a line written to land exactly on the
 * limit overruns it half the time. The margin costs a few words and turns a
 * coin-toss into a comfortable fit; the audio compressor absorbs what is left.
 */
const LINE_BUDGET_SAFETY = 0.93;

export async function generateStoryboard(input: {
  brief: string;
  creator: Creator;
  settings: ProjectSettings;
  /** Descriptions of any supplied background / mood-board references. */
  referenceNotes?: string;
  /**
   * The video model's per-clip limits. Passed in rather than assumed, because a
   * storyboard whose scenes exceed the renderer's maximum clip length cannot be
   * rendered as written — the shot gets clamped and the narration overruns it.
   */
  clipLimits?: { min: number; max: number };
  /**
   * Shortest line the renderer can voice through its best path. Below this the
   * video model rejects the voice track as a reference and the clip has to fall
   * back to attaching audio afterwards, which is a visibly worse result.
   */
  minSpokenSeconds?: number;
  /**
   * Longest line the video model can perform natively, in seconds.
   *
   * Beyond it the model cannot take the recording as a reference at all, and
   * the pipeline falls back to rendering the shot silent and lip-syncing the
   * voice on afterwards — which is visibly worse, and is what "the lips do not
   * match" looks like.
   */
  maxSpokenSeconds?: number;
  /**
   * Whether the project supplied an outfit photo. The picked outfit and the
   * photo are two answers to the same question, and the photo is the one the
   * renderer actually attaches.
   */
  wardrobeFromPhoto?: boolean;
  /**
   * How fast the creator's chosen voice actually speaks, in characters per
   * second, measured rather than assumed.
   *
   * Characters because words are not a unit of time: the same voice read one
   * line at 3.52 words per second and another at 2.17, while its character rate
   * moved far less. Budgets computed from the wrong rate are how a line written
   * for a fifteen-second shot comes back nineteen seconds long.
   */
  charsPerSecond?: number;
  /**
   * A script the operator wrote themselves. When present it is the spoken
   * content — the writer splits it across scenes rather than inventing lines.
   */
  script?: string;
}): Promise<StoryboardResult> {
  const { brief, creator, settings } = input;
  const limits = input.clipLimits ?? { min: 3, max: 15 };
  const minSpoken = input.minSpokenSeconds ?? 0;
  const maxSpoken = input.maxSpokenSeconds ?? 0;
  const pace = input.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
  // Expressed per second so the writer can size each line against its own
  // scene. A single ceiling only describes the longest possible shot, which
  // says nothing useful about a five-second one.
  const perSecond = Math.floor(pace * LINE_BUDGET_SAFETY);

  /**
   * What gets planned for is what was asked for. No quiet shortfall.
   *
   * This used to shave a margin off a single-shot piece so the recording stayed
   * inside the window the video model accepts a voice reference in. That window
   * only ever mattered for letting the model perform the line itself, which this
   * pipeline no longer does — the creator's own recording is the audio. So the
   * margin bought nothing and cost seconds: a 15-second brief planned 13.5s and
   * delivered 11.4s.
   *
   * One second is still held back on a single-shot piece, and only that: the
   * picture has to come out at least as long as the recording, or the lip-sync
   * model stretches the shot to cover the overhang and the mouth slides out of
   * step across the whole clip. That is a fraction under the ask, not the
   * seconds the old margin cost. A longer piece splits across shots and each
   * line has room already.
   */
  const plannedDuration =
    maxSpoken && settings.targetDurationSeconds <= limits.max
      ? Math.min(settings.targetDurationSeconds, maxSpoken)
      : settings.targetDurationSeconds;
  const requestedSceneCount =
    settings.kind === "video" ? settings.requestedSceneCount : undefined;
  if (
    requestedSceneCount &&
    (plannedDuration < requestedSceneCount * limits.min ||
      plannedDuration > requestedSceneCount * limits.max)
  ) {
    throw new Error(
      `${requestedSceneCount} scene${requestedSceneCount === 1 ? "" : "s"} cannot cover ` +
        `${plannedDuration} seconds: each generated clip must be ${limits.min}-${limits.max} seconds.`,
    );
  }
  const production = describeVideoStyle(settings.videoStyle, {
    wardrobeFromPhoto: input.wardrobeFromPhoto,
  });

  const user = [
    `BRIEF: ${brief}`,
    input.script?.trim()
      ? `SCRIPT — USE THIS TEXT, DO NOT REWRITE IT:\n${input.script.trim()}\n\n` +
        `Split it across the scenes in order, word for word. You may only decide WHERE the ` +
        `splits fall and how many scenes there are; you may not add, drop or reword anything. ` +
        `"transcript" must come back as exactly this text. Choose scene durations that fit the ` +
        `words at about 2.5 words per second, then adjust the shot list to match — the script ` +
        `is fixed and the pictures follow it, not the other way round.`
      : "",
    "",
    settings.kind === "photo"
      ? `HOW MANY IMAGES: ${photoCount(settings.photoCount)} distinct stills — exactly that many scenes.`
      : `TOTAL DURATION: ${plannedDuration} seconds. Scene durations must sum to exactly this.` +
        (plannedDuration < settings.targetDurationSeconds
          ? ` (The operator asked for ${settings.targetDurationSeconds}s. ${plannedDuration}s is the ` +
            `longest this can be told in one continuous shot that the model can perform itself, and ` +
            `that performance matters more than the last second. Write to ${plannedDuration}s.)`
          : ""),
    `CLIP LIMITS: every scene must be between ${limits.min} and ${limits.max} seconds — that is what the video model can render in one shot.`,
    minSpoken
      ? `MINIMUM LINE LENGTH: any scene that has dialogue needs enough of it to speak for at least ` +
        `${minSpoken} seconds — at least ${Math.ceil(minSpoken * pace)} characters. A shorter line cannot be ` +
        `used to drive the performance and the shot comes out worse. Write a fuller line, or merge ` +
        `the beat into a neighbouring scene — never leave the line empty, and never leave a ` +
        `two-word fragment.`
      : "",
    // A line longer than one shot cannot be rendered at all: the clip is cut to
    // the length of the recording, the renderer caps it at the ceiling, and
    // whatever the line still had to say past that point is simply not in the
    // video. Splitting the scene is the fix, and it is the writer's to make.
    maxSpoken
      ? `MAXIMUM LINE LENGTH: this creator's voice has been measured at ${pace.toFixed(1)} ` +
        `characters per second. Budget every line at ${perSecond} characters per second of ITS ` +
        `OWN scene duration, counting spaces and punctuation — a ${limits.min}s scene allows about ` +
        `${limits.min * perSecond} characters, a 10s scene about ${10 * perSecond}. No line may ` +
        `exceed ${maxSpoken * perSecond} characters whatever its scene says, because ${maxSpoken}s ` +
        `is the longest single shot this model renders and the longest recording it can perform ` +
        `from; past that the shot is rendered out of sync.\n` +
        `Do not substitute a rate that feels more natural — this one was measured on this voice. ` +
        `Count the characters of every line against its own scene's duration before you answer. ` +
        `A line that does not fit is not a line to trim later: give the beat a longer scene, or ` +
        `split it across two.\n` +
        `Aim to USE that budget, not to come in well under it. A line that fills less than about ` +
        `three quarters of its scene leaves the rest of the shot with nothing to do, and the model ` +
        `fills silence with invented movement — the subject drifts, glances away, starts to turn. ` +
        `Target ${Math.floor(perSecond * 0.85)}-${perSecond} characters per second of scene.`
      : "",
    `FORMAT: ${settings.aspectRatio} ${
      settings.aspectRatio === "9:16" ? "(vertical social)" : ""
    }`,
    settings.kind === "photo" ? PHOTO_BRIEF : "",
    settings.look === "cinematic" ? CINEMATIC_LOOK_BRIEF : PHONE_LOOK_BRIEF,
    // The operator's structured picks. Placed above the free-text style so the
    // prose can still override them — it is the more specific instruction.
    production
      ? `PRODUCTION BRIEF — follow these:\n${production}\n\nWhere any of this contradicts the ` +
        `BRIEF above, the BRIEF wins: it is what the operator actually wrote, and it is more ` +
        `specific than a menu choice. A brief naming a luxury corner office beats a setting ` +
        `picked as "home office".`
      : "",
    settings.globalStyle ? `GLOBAL VISUAL STYLE: ${settings.globalStyle}` : "",
    "",
    "PRESENTER CONTEXT (for tone and subject-matter voice only — do NOT describe their appearance):",
    `- Category: ${creator.category || "general"}`,
    `- Persona: ${creator.persona || "not specified"}`,
    input.referenceNotes ? `\nSUPPLIED REFERENCES: ${input.referenceNotes}` : "",
    "",
    // The floor is arithmetic, not taste: no scene can exceed the clip ceiling,
    // so a 90-second piece cannot be told in fewer than six 15-second shots. It
    // is stated first because a writer that ignores it produces a storyboard
    // whose durations cannot be made to sum to the target at all.
    requestedSceneCount
      ? `SCENE COUNT: EXACTLY ${requestedSceneCount}. This is an operator decision, not a suggestion. ` +
        `Return exactly ${requestedSceneCount} scene${requestedSceneCount === 1 ? "" : "s"}; ` +
        `compose the script and shot list to fit without adding cuts.`
      : `SCENE COUNT: at least ${minSceneCount(settings.targetDurationSeconds, limits.max)} scenes ` +
        `— no single clip can run longer than ${limits.max}s, so a ${settings.targetDurationSeconds}s ` +
        `piece needs at least that many. Beyond the minimum, use the FEWEST that actually tell this ` +
        `story, and at most ${maxSceneCount(settings.targetDurationSeconds, limits.max)}. A single ` +
        `unbroken shot is a perfectly good storyboard when the brief is one moment in one place and ` +
        `the minimum allows it; do not invent cuts to fill a quota. Add a scene when the story ` +
        `changes location, subject or beat, or when a line would overrun the ${limits.max}s ceiling.`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await llmProvider().json({
    task: "storyboard",
    system: STORYBOARD_SYSTEM,
    user,
    schema: storyboardSchema,
    parse: (value) => {
      const parsed = parseStoryboard(value);
      const exactCount =
        settings.kind === "photo" ? photoCount(settings.photoCount) : requestedSceneCount;
      if (exactCount && parsed.scenes.length !== exactCount) {
        throw new Error(
          `Storyboard returned ${parsed.scenes.length} scenes; exactly ${exactCount} required.`,
        );
      }
      return parsed;
    },
    maxTokens: 32000,
  });

  // A photo set has no timeline to reconcile, and forcing its stills to sum to
  // a duration would only stretch numbers nobody reads.
  return settings.kind === "photo"
    ? result
    // Normalised against the duration that was planned for, not the one asked
    // for. Reconciling to the request would put back the second the ceiling was
    // there to remove, and the take would overrun again.
    : normaliseDurations(result, plannedDuration, limits);
}

/**
 * A *ceiling*, not a target.
 *
 * This used to be a fixed count per duration, which forced a brief like "one
 * 10-second shot of the creator in a cafe" into three cuts it never asked for.
 * A scene is a cut; how many cuts a story needs is the story's business. The
 * prompt asks for the fewest that tell it, and this only stops a short piece
 * from being shredded into more cuts than its seconds can carry.
 */
function maxSceneCount(totalSeconds: number, clipMax: number): number {
  // A piece that fits inside a single clip IS a single clip.
  //
  // Cutting a 15-second story into two 8-second shots buys nothing and costs
  // everything the cut has to re-establish: the room, the light, the framing,
  // the performer's energy. Observed on a 15-second test — two clips, two
  // visibly different corners of the same bedroom, and a dead beat at the join.
  // One continuous take has no seam to get wrong.
  //
  // Above the ceiling a cut is arithmetic rather than taste: the story cannot
  // be told in one shot, so the ceiling below decides how few it can be.
  if (totalSeconds <= clipMax) return 1;
  return Math.max(1, Math.floor(totalSeconds / Math.max(4, Math.min(clipMax, 6))));
}

/**
 * Claude gets scene durations very close but not always exact. Rather than
 * failing the generation, absorb the difference into the longest scene — the
 * least perceptible place to put it.
 */
/**
 * Make the scene durations sum to what was asked for.
 *
 * This used to dump the entire difference on the single longest scene and then
 * clamp it to the clip ceiling, which was survivable at 30 seconds and silently
 * wrong at 90: a storyboard 40 seconds short would absorb at most 15 of them and
 * the project would quietly render two-thirds of the requested length. The
 * difference is now spread across every scene, a pass at a time, so it is
 * absorbed as long as the scenes have any headroom left at all.
 *
 * When the scenes genuinely cannot reach the target — too few of them for the
 * clip ceiling — the result is the closest reachable total rather than a wrong
 * one, and the caller's scene-count floor is what stops that happening.
 */
function normaliseDurations(
  result: StoryboardResult,
  target: number,
  limits: { min: number; max: number },
): StoryboardResult {
  if (result.scenes.length === 0) return result;
  const scenes = result.scenes.map((scene) => ({ ...scene }));

  const totalOf = () => scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (Math.abs(target - totalOf()) < 0.01) return result;

  // Several passes: each one shares out what is left over the scenes that still
  // have room, so a scene hitting its ceiling hands the remainder to the others
  // instead of swallowing it.
  for (let pass = 0; pass < 8; pass += 1) {
    const delta = target - totalOf();
    if (Math.abs(delta) < 0.01) break;

    const movable = scenes.filter((scene) =>
      delta > 0 ? scene.durationSeconds < limits.max : scene.durationSeconds > limits.min,
    );
    if (movable.length === 0) break;

    const share = delta / movable.length;
    for (const scene of movable) {
      scene.durationSeconds = round1(
        Math.max(limits.min, Math.min(limits.max, scene.durationSeconds + share)),
      );
    }
  }

  return { ...result, scenes };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The fewest scenes that can carry the requested duration, given that no single
 * clip may exceed the model's ceiling.
 */
/**
 * How many stills a photo set gets.
 *
 * Reuses the duration field rather than adding a second number to the schema:
 * for a photo project the form labels it "images" and writes the count there.
 */
function photoCount(value: number): number {
  return Math.max(1, Math.min(12, Math.round(value)));
}

function minSceneCount(totalSeconds: number, clipMax: number): number {
  return Math.max(1, Math.ceil(totalSeconds / Math.max(1, clipMax)));
}

// ---------------------------------------------------------------------------
// Free-form instruction parsing
// ---------------------------------------------------------------------------

const SCENE_SPEC_SYSTEM = `You convert a director's shorthand into a complete, structured shot
specification for an AI image and video pipeline.

Input looks like: "Medium shot, smiling, holding coffee, sunrise lighting, cinematic."

Fill in every field. Where the instruction is silent, choose something coherent with what
was stated rather than leaving it thin — but never contradict an explicit instruction.

HARD RULE: refer to the subject only as the literal token {CREATOR}. Never describe the
subject's appearance, age, gender, or ethnicity — a separate identity system owns that.
Leave "wardrobe" empty unless the instruction names specific clothing. If it is not empty,
fully specify one colour, material and cut for every visible garment and repeat the exact
same wardrobe text in every scene; never leave an item such as a skirt or trousers uncoloured.

HARD RULE: never put the recording device in the scene — no phone propped up, no tripod,
no ring light, no camera in frame. The camera is the viewer's eye, not an object in the
room. If the instruction mentions one, treat it as a note about how the shot is framed,
not as something to render. A phone the subject is USING in the story is fine.`;

/**
 * Turn a one-line director's instruction into a full SceneSpec. This backs the
 * "instruction control" surface: a user types shorthand and gets structured,
 * editable camera / expression / pose / lighting / mood fields.
 */
export async function parseInstruction(input: {
  instruction: string;
  creator: Creator;
  /** Existing spec to refine, when editing rather than creating. */
  base?: SceneSpec;
}): Promise<SceneSpec> {
  const user = [
    `INSTRUCTION: ${input.instruction}`,
    "",
    `PRESENTER CONTEXT (tone only, not appearance): ${input.creator.persona || "not specified"}`,
    input.base
      ? `\nREFINE this existing specification, changing only what the instruction implies:\n${JSON.stringify(input.base, null, 2)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return llmProvider().json({
    task: "scene_prompt",
    system: SCENE_SPEC_SYSTEM,
    user,
    schema: sceneSpecSchema,
    parse: parseSceneSpec,
    maxTokens: 8000,
  });
}

/** Internals exposed for tests only. */
export const __testing = { normaliseDurations, minSceneCount, maxSceneCount };
