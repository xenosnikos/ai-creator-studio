/**
 * Structured options for the *video*, as opposed to the creator.
 *
 * Deliberately not a second copy of `look.ts`. That one answers "who is this
 * person", which is fixed for the life of a creator; this one answers "what is
 * this particular post", which changes every time. The same creator shooting a
 * calm morning skincare routine and a hyped gym piece is the whole point of the
 * tool, and none of these fields belong on them permanently.
 *
 * These picks are handed to the storyboard writer, not to the image model. That
 * matters: the renderer can enforce a camera but it cannot undo a storyboard
 * written for the wrong medium, so pacing and setting have to land before the
 * scenes exist rather than after.
 *
 * Every field is optional. Anything left unset is left to the writer, which is
 * exactly what the brief text is for.
 */

export const VIDEO_FORMATS = [
  "talking_head",
  "tutorial",
  "story_time",
  "listicle",
  "review",
  "day_in_life",
  "tour",
  "get_ready",
] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const PACINGS = ["one_take", "steady", "quick_cuts"] as const;
export type Pacing = (typeof PACINGS)[number];

export const ENERGIES = ["calm", "conversational", "upbeat", "hyped", "serious"] as const;
export type Energy = (typeof ENERGIES)[number];

export const SETTINGS = [
  "bedroom",
  "living_room",
  "kitchen",
  "bathroom",
  "home_office",
  "gym",
  "cafe",
  "restaurant",
  "street",
  "shop",
  "car",
  "outdoors",
  "beach",
  "hotel",
] as const;
export type Setting = (typeof SETTINGS)[number];

export const TIMES_OF_DAY = ["morning", "midday", "afternoon", "golden_hour", "evening", "night"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

/**
 * What the creator is wearing in this piece, as distinct from the default
 * wardrobe on their identity. An uploaded outfit photo overrides this.
 */
export const OUTFITS = [
  "casual",
  "loungewear",
  "streetwear",
  "gym",
  "smart_casual",
  "formal",
  "going_out",
  "swimwear",
  "workwear",
] as const;
export type Outfit = (typeof OUTFITS)[number];

export const HOOKS = ["question", "bold_claim", "problem", "visual", "straight_in"] as const;
export type Hook = (typeof HOOKS)[number];

export const ENDINGS = ["follow", "comment", "link", "punchline", "just_stop"] as const;
export type Ending = (typeof ENDINGS)[number];

export interface VideoStyle {
  format?: VideoFormat;
  pacing?: Pacing;
  energy?: Energy;
  setting?: Setting;
  timeOfDay?: TimeOfDay;
  outfit?: Outfit;
  hook?: Hook;
  ending?: Ending;
}

/** What the operator sees. */
export const VIDEO_LABELS = {
  format: {
    talking_head: "Talking to camera",
    tutorial: "How-to / tutorial",
    story_time: "Story time",
    listicle: "List / countdown",
    review: "Review",
    day_in_life: "Day in the life",
    tour: "Tour / walkthrough",
    get_ready: "Get ready with me",
  } satisfies Record<VideoFormat, string>,
  pacing: {
    one_take: "One take, no cuts",
    steady: "Steady — a few cuts",
    quick_cuts: "Quick cuts",
  } satisfies Record<Pacing, string>,
  energy: {
    calm: "Calm",
    conversational: "Conversational",
    upbeat: "Upbeat",
    hyped: "Hyped",
    serious: "Serious",
  } satisfies Record<Energy, string>,
  setting: {
    bedroom: "Bedroom",
    living_room: "Living room",
    kitchen: "Kitchen",
    bathroom: "Bathroom",
    home_office: "Home office",
    gym: "Gym",
    cafe: "Café",
    restaurant: "Restaurant",
    street: "Street",
    shop: "Shop",
    car: "Car",
    outdoors: "Outdoors",
    beach: "Beach",
    hotel: "Hotel",
  } satisfies Record<Setting, string>,
  timeOfDay: {
    morning: "Morning",
    midday: "Midday",
    afternoon: "Afternoon",
    golden_hour: "Golden hour",
    evening: "Evening",
    night: "Night",
  } satisfies Record<TimeOfDay, string>,
  outfit: {
    casual: "Casual",
    loungewear: "Loungewear",
    streetwear: "Streetwear",
    gym: "Gym wear",
    smart_casual: "Smart casual",
    formal: "Formal",
    going_out: "Going out",
    swimwear: "Swimwear",
    workwear: "Work uniform",
  } satisfies Record<Outfit, string>,
  hook: {
    question: "Open with a question",
    bold_claim: "Open with a bold claim",
    problem: "Open with the problem",
    visual: "Open on a visual",
    straight_in: "Straight into it",
  } satisfies Record<Hook, string>,
  ending: {
    follow: "Ask for a follow",
    comment: "Ask for comments",
    link: "Point to the link",
    punchline: "End on a punchline",
    just_stop: "Just end",
  } satisfies Record<Ending, string>,
};

/**
 * The instruction each option contributes.
 *
 * Written as directions to a director rather than as adjectives, because the
 * consumer is a writer producing structured scenes: "cut on every beat, 2–4
 * seconds a shot" is actionable where "fast-paced" is not.
 */
const PHRASES = {
  format: {
    talking_head:
      "a straight talking-to-camera piece — the presenter addresses the viewer directly for most of the runtime",
    tutorial:
      "a how-to: show the steps in order, with the presenter explaining each one as it happens",
    story_time:
      "a story told to camera, with a setup, a turn and a payoff, cut with shots of what is being described",
    listicle:
      "a numbered list or countdown — each item is its own beat, stated plainly before it is explained",
    review:
      "a review: the thing itself is on screen and handled, and the verdict is stated rather than hinted at",
    day_in_life:
      "a day-in-the-life: a sequence of moments through the day, lightly narrated, place and time visibly moving on",
    tour: "a walkthrough of a place, moving through it in a way the viewer can follow",
    get_ready:
      "a get-ready-with-me: the presenter talks while getting ready, the routine progressing visibly across the scenes",
  } satisfies Record<VideoFormat, string>,
  pacing: {
    one_take:
      "ONE unbroken shot for the whole piece if the duration allows it — do not cut unless the clip ceiling forces it",
    steady: "a few deliberate cuts; let shots breathe rather than cutting for its own sake",
    // No fixed seconds here. Naming a number ("3 to 5 seconds") fought the clip
    // minimum the renderer supplies, and a storyboard told two different floors
    // resolves it by ignoring one of them.
    quick_cuts:
      "cut often — keep every scene near the SHORT end of the clip limits given above, with a new angle or a new beat on each one",
  } satisfies Record<Pacing, string>,
  energy: {
    calm: "calm and unhurried, low-key delivery, quiet rooms",
    conversational: "relaxed and conversational, like talking to a friend",
    upbeat: "upbeat and warm, quick and lively without shouting",
    hyped: "high energy and emphatic — short punchy sentences, strong gestures",
    serious: "measured and serious, direct, no jokes",
  } satisfies Record<Energy, string>,
  setting: {
    bedroom: "a bedroom",
    living_room: "a living room",
    kitchen: "a kitchen",
    bathroom: "a bathroom",
    home_office: "a home office or desk setup",
    gym: "a gym",
    cafe: "a café",
    restaurant: "a restaurant",
    street: "a street outdoors",
    shop: "a shop",
    car: "the driver's seat of a parked car",
    outdoors: "outdoors in a natural setting",
    beach: "a beach",
    hotel: "a hotel room",
  } satisfies Record<Setting, string>,
  timeOfDay: {
    morning: "morning — early, soft low light",
    midday: "the middle of the day, bright and high-contrast",
    afternoon: "the afternoon, warm and settled",
    golden_hour: "golden hour, low warm sun and long shadows",
    evening: "the evening, after sunset, lamps and mixed indoor light",
    night: "at night — dark outside, artificial light only",
  } satisfies Record<TimeOfDay, string>,
  outfit: {
    casual: "everyday casual clothes",
    loungewear: "loungewear or comfortable clothes worn at home",
    streetwear: "streetwear",
    gym: "gym or athletic wear",
    smart_casual: "smart-casual clothes",
    formal: "formal clothes",
    going_out: "a going-out outfit, dressed up for the evening",
    swimwear: "swimwear, appropriate to the setting",
    workwear: "a work uniform appropriate to the subject",
  } satisfies Record<Outfit, string>,
  hook: {
    question: "open with a question straight to the viewer",
    bold_claim: "open with a bold claim or a strong statement",
    problem: "open by naming the problem the viewer has",
    visual: "open on a visual that earns the next two seconds, with the line coming after it",
    straight_in: "no hook device — start in the middle of the subject",
  } satisfies Record<Hook, string>,
  ending: {
    follow: "end by asking for a follow",
    comment: "end by asking a question that invites comments",
    link: "end by pointing the viewer to the link",
    punchline: "end on a punchline or a turn, not on a request",
    just_stop: "end on the last real line — no sign-off, no call to action",
  } satisfies Record<Ending, string>,
};

/**
 * Turn the picks into a production brief for the storyboard writer.
 *
 * Returns an empty string when nothing is picked, so a project driven entirely
 * by its brief text behaves exactly as it did before this existed.
 */
export function describeVideoStyle(
  style: VideoStyle | null | undefined,
  options: {
    /**
     * True when the operator also uploaded a photo of the outfit.
     *
     * The photo wins. Without this the picked outfit told the writer to fill in
     * every scene's wardrobe field while the reference note told it to leave
     * that field empty — one instruction contradicting the other in the same
     * prompt, which is how you get a garment that matches neither.
     */
    wardrobeFromPhoto?: boolean;
  } = {},
): string {
  if (!style) return "";
  const lines: string[] = [];

  if (style.format) lines.push(`Format: ${PHRASES.format[style.format]}.`);
  if (style.pacing) lines.push(`Pacing: ${PHRASES.pacing[style.pacing]}.`);
  if (style.energy) lines.push(`Energy: ${PHRASES.energy[style.energy]}.`);

  // Place and time land together — a kitchen at night and a kitchen at golden
  // hour are different rooms as far as every downstream field is concerned.
  const place = [
    style.setting ? `set in ${PHRASES.setting[style.setting]}` : "",
    style.timeOfDay ? `at ${PHRASES.timeOfDay[style.timeOfDay]}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (place) {
    lines.push(
      `Place and time: ${place}. Keep every scene consistent with this — the same place ` +
        `and the same time of day throughout unless the brief says the story travels.`,
    );
  }

  if (style.outfit) {
    lines.push(
      options.wardrobeFromPhoto
        ? `Wardrobe: an outfit photo is supplied and it is the source of truth — leave every ` +
          `scene's "wardrobe" field empty. For context only, it is ${PHRASES.outfit[style.outfit]}; ` +
          `write actions and poses that suit that, but do not describe the clothing.`
        : `Wardrobe: the presenter is in ${PHRASES.outfit[style.outfit]}. Put this in the ` +
          `"wardrobe" field of every scene, phrased for the shot, and keep it identical across ` +
          `scenes unless the story requires a change.`,
    );
  }

  if (style.hook) lines.push(`Opening: ${PHRASES.hook[style.hook]}.`);
  if (style.ending) lines.push(`Ending: ${PHRASES.ending[style.ending]}.`);

  return lines.join("\n");
}

/** True when the operator has actually chosen something. */
export function hasVideoStyle(style: VideoStyle | null | undefined): boolean {
  return Boolean(style && Object.values(style).some(Boolean));
}
