/**
 * Structured appearance options for a creator.
 *
 * Free-text notes work, but only if the operator happens to phrase them the way
 * an image model responds to — and the lesson of this project is that they
 * usually do not. "Curvy" gets averaged away; "very large bust, wide hips, full
 * rounded rear, narrow waist" does not. So every option here carries the
 * wording that actually lands, and the operator picks a label instead of having
 * to discover the phrasing.
 *
 * Each field is optional. Anything left unset is simply not mentioned, which
 * leaves the identity writer free to invent it.
 */

export const SEXES = ["female", "male"] as const;
export type Sex = (typeof SEXES)[number];

export const AGE_BANDS = ["18-24", "25-34", "35-44", "45-59", "60+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const BODY_TYPES = [
  "slim",
  "petite",
  "athletic",
  "toned",
  "average",
  "curvy",
  "hourglass",
  "voluptuous",
  "thick",
  "plus_size",
  "bbw",
  "muscular",
  "stocky",
  "lanky",
  "dad_bod",
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const BUSTS = ["small", "medium", "full", "very_large"] as const;
export type Bust = (typeof BUSTS)[number];

export const HIPS = ["narrow", "average", "wide", "very_wide"] as const;
export type Hips = (typeof HIPS)[number];

export const HEIGHTS = ["petite", "average", "tall"] as const;
export type Height = (typeof HEIGHTS)[number];

export const FACE_SHAPES = ["oval", "round", "heart", "square", "long", "diamond"] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

export const SKIN_TONES = [
  "very_fair",
  "fair",
  "light_olive",
  "olive",
  "tan",
  "brown",
  "deep_brown",
] as const;
export type SkinTone = (typeof SKIN_TONES)[number];

export const HAIR_COLOURS = [
  "platinum_blonde",
  "blonde",
  "dark_blonde",
  "light_brown",
  "brown",
  "dark_brown",
  "black",
  "auburn",
  "red",
  "grey",
] as const;
export type HairColour = (typeof HAIR_COLOURS)[number];

export const HAIR_LENGTHS = ["buzzed", "short", "chin", "shoulder", "long", "very_long"] as const;
export type HairLength = (typeof HAIR_LENGTHS)[number];

export const EYE_COLOURS = ["blue", "green", "hazel", "light_brown", "brown", "grey"] as const;
export type EyeColour = (typeof EYE_COLOURS)[number];

export const LOOK_STYLES = ["natural", "polished", "glamorous", "edgy", "girl_next_door"] as const;
export type LookStyle = (typeof LOOK_STYLES)[number];

/**
 * How hard to push attractiveness.
 *
 * Separate from body type on purpose. "Curvy" describes a shape; it says
 * nothing about whether the person is meant to read as hot, and left to itself
 * an image model resolves a curvy brief as simply heavy. This dial is the part
 * that says *sexy*, and at the top settings it also drives the waist, the
 * stomach and the wardrobe, because those are what the difference actually
 * consists of.
 */
export const APPEALS = ["everyday", "pretty", "sexy", "bombshell"] as const;
export type Appeal = (typeof APPEALS)[number];

export interface CreatorLook {
  sex?: Sex;
  ageBand?: AgeBand;
  bodyType?: BodyType;
  bust?: Bust;
  hips?: Hips;
  height?: Height;
  faceShape?: FaceShape;
  skinTone?: SkinTone;
  hairColour?: HairColour;
  hairLength?: HairLength;
  eyeColour?: EyeColour;
  style?: LookStyle;
  appeal?: Appeal;
}

/** What the operator sees. */
export const LABELS = {
  sex: { female: "Female", male: "Male" } satisfies Record<Sex, string>,
  ageBand: {
    "18-24": "18–24",
    "25-34": "25–34",
    "35-44": "35–44 (MILF / DILF register)",
    "45-59": "45–59",
    "60+": "60+",
  } satisfies Record<AgeBand, string>,
  bodyType: {
    slim: "Slim",
    petite: "Petite",
    athletic: "Athletic",
    toned: "Toned",
    average: "Average",
    curvy: "Curvy",
    hourglass: "Hourglass",
    voluptuous: "Voluptuous",
    thick: "Thick",
    plus_size: "Plus size",
    bbw: "BBW",
    muscular: "Muscular",
    stocky: "Stocky",
    lanky: "Lanky",
    dad_bod: "Dad bod",
  } satisfies Record<BodyType, string>,
  bust: {
    small: "Small",
    medium: "Medium",
    full: "Full",
    very_large: "Very large",
  } satisfies Record<Bust, string>,
  hips: {
    narrow: "Narrow",
    average: "Average",
    wide: "Wide",
    very_wide: "Very wide",
  } satisfies Record<Hips, string>,
  height: { petite: "Short", average: "Average", tall: "Tall" } satisfies Record<Height, string>,
  faceShape: {
    oval: "Oval",
    round: "Round",
    heart: "Heart",
    square: "Square",
    long: "Long",
    diamond: "Diamond",
  } satisfies Record<FaceShape, string>,
  skinTone: {
    very_fair: "Very fair",
    fair: "Fair",
    light_olive: "Light olive",
    olive: "Olive",
    tan: "Tan",
    brown: "Brown",
    deep_brown: "Deep brown",
  } satisfies Record<SkinTone, string>,
  hairColour: {
    platinum_blonde: "Platinum blonde",
    blonde: "Blonde",
    dark_blonde: "Dark blonde",
    light_brown: "Light brown",
    brown: "Brown",
    dark_brown: "Dark brown",
    black: "Black",
    auburn: "Auburn",
    red: "Red",
    grey: "Grey",
  } satisfies Record<HairColour, string>,
  hairLength: {
    buzzed: "Buzzed",
    short: "Short",
    chin: "Chin length",
    shoulder: "Shoulder length",
    long: "Long",
    very_long: "Very long",
  } satisfies Record<HairLength, string>,
  eyeColour: {
    blue: "Blue",
    green: "Green",
    hazel: "Hazel",
    light_brown: "Light brown",
    brown: "Brown",
    grey: "Grey",
  } satisfies Record<EyeColour, string>,
  style: {
    natural: "Natural / no-makeup",
    polished: "Polished",
    glamorous: "Glamorous",
    edgy: "Edgy",
    girl_next_door: "Girl next door",
  } satisfies Record<LookStyle, string>,
  appeal: {
    everyday: "Everyday",
    pretty: "Pretty",
    sexy: "Sexy",
    bombshell: "Bombshell (max)",
  } satisfies Record<Appeal, string>,
};

/**
 * The wording each option contributes to the brief.
 *
 * Deliberately blunt where bluntness is what works. A body described mildly
 * comes back average from every image model tested, so the strong options say
 * plainly what they mean rather than reaching for a flattering synonym.
 */
const PHRASES = {
  bodyType: {
    slim: "a slim, slender build with narrow hips and little curve",
    petite: "a petite, small-framed build, short and finely built",
    athletic: "an athletic build with visible tone, broad shoulders and a flat stomach",
    toned: "a toned, gym-fit build with clear definition but soft lines",
    average: "an ordinary average build, neither slim nor heavy",
    // The curvy family all restate the waist and the stomach. Left to itself an
    // image model resolves "curvy", "voluptuous" or "thick" as simply
    // overweight — the shape the operator wants is full at the bust and hips and
    // *tight* everywhere else, and that only happens if it is said outright.
    curvy:
      "a curvy but fit build — full bust, wide hips and a small clearly defined waist above a flat toned stomach; shapely, not heavy or overweight",
    hourglass:
      "a dramatic hourglass figure — full bust, wide rounded hips and a distinctly narrow waist above a flat toned stomach; fit and shapely, not heavy",
    voluptuous:
      "a voluptuous but fit figure — a very large full bust, wide hips and a full rounded rear, with a narrow waist and a flat toned stomach between them; curvy in the bust and hips only, not overweight",
    thick:
      "a thick, curvy build — heavy hips, full thighs and a full rounded rear, with a smaller waist and a flat stomach above them; solid and shapely rather than slim, but not overweight",
    plus_size: "a plus-size build, heavy and full-figured throughout, soft and rounded",
    bbw: "a big, full-figured plus-size build — heavy bust, wide hips, full stomach and thighs",
    muscular: "a muscular, heavily built physique with pronounced muscle mass",
    stocky: "a stocky, thickset build, broad and solid",
    lanky: "a lanky build — tall, thin and long-limbed",
    dad_bod: "a soft, average-to-heavy build with a bit of a stomach and little muscle definition",
  } satisfies Record<BodyType, string>,
  bust: {
    small: "a small bust",
    medium: "a medium bust",
    full: "a full bust",
    very_large: "a very large, heavy bust",
  } satisfies Record<Bust, string>,
  hips: {
    narrow: "narrow hips",
    average: "average hips",
    wide: "wide hips and a full rear",
    very_wide: "very wide hips and a large, full rounded rear",
  } satisfies Record<Hips, string>,
  height: {
    petite: "short",
    average: "average height",
    tall: "tall",
  } satisfies Record<Height, string>,
  ageBand: {
    "18-24": "in their early twenties",
    "25-34": "in their late twenties to early thirties",
    "35-44": "in their late thirties to early forties, mature and confident",
    "45-59": "in their fifties",
    "60+": "in their sixties or older",
  } satisfies Record<AgeBand, string>,
  style: {
    natural: "a natural, barely-there look with minimal makeup",
    polished: "a polished, put-together look with everyday makeup",
    glamorous:
      "a glamorous, high-maintenance look — full makeup and styled hair, striking, though the makeup still sits on real skin rather than erasing it",
    edgy: "an edgy look — sharper styling, stronger makeup",
    girl_next_door: "an approachable girl-next-door look, warm and unintimidating",
  } satisfies Record<LookStyle, string>,
  // The top two settings say "sexy" in as many words, and then spend the rest of
  // the sentence on what sexy is actually made of — the face, the waist, the
  // stomach and the clothing. Saying only "attractive" gets averaged into
  // "pleasant-looking", which is the complaint these settings exist to fix.
  appeal: {
    everyday:
      "ordinary everyday looks, believable and unremarkable, nothing heightened",
    pretty:
      "genuinely pretty — a clean, photogenic, well-proportioned face of the kind people notice, without being styled as a model",
    sexy:
      "unmistakably sexy and hot: a striking, beautiful face, a fit body with a small waist and a flat toned stomach, long legs, and clothing that is fitted and shows the figure rather than hiding it. Not plain, not heavy, not ordinary — but a real woman who happens to be gorgeous, photographed as she is, with real skin and a real face rather than a retouched or rendered one",
    bombshell:
      "an absolute bombshell — as sexy and hot as this brief allows. A stunning face, styled hair, makeup worn well but still sitting on the skin rather than erasing it, a fit body with a small waist, a flat toned stomach and long legs, and a tight, low-cut, figure-showing outfit. This person turns heads in every frame. Do NOT render them plain, heavy, overweight or ordinary — and equally do NOT make them flawless, airbrushed or doll-like. The most beautiful people alive still have pores, texture and a slightly uneven face; that is what makes a photograph of them read as a photograph",
  } satisfies Record<Appeal, string>,
};

const humanise = (value: string) => value.replace(/_/g, " ");

/**
 * Turn the picked options into a brief for the identity writer.
 *
 * Returns an empty string when nothing is set, so a creator built entirely from
 * free text behaves exactly as before.
 */
export function describeLook(look: CreatorLook | null | undefined): string {
  if (!look) return "";
  const parts: string[] = [];

  // Noun first, then the age clause — the other order produced "A in their
  // late twenties woman."
  if (look.ageBand || look.sex) {
    const noun = look.sex ? (look.sex === "female" ? "woman" : "man") : "person";
    const age = look.ageBand ? ` ${PHRASES.ageBand[look.ageBand]}` : "";
    parts.push(`A ${noun}${age}.`);
  }

  const build = look.bodyType ? PHRASES.bodyType[look.bodyType] : "";
  const height = look.height ? PHRASES.height[look.height] : "";
  if (build || height) {
    parts.push(
      `Build: ${[height, build].filter(Boolean).join(", with ")}.`.replace("Build: , with ", "Build: "),
    );
  }

  // Bust and hips are stated separately from the build word because they are
  // the two the models flatten hardest, and repeating them is what makes them
  // survive a long prompt.
  const shape = [
    look.bust ? PHRASES.bust[look.bust] : "",
    look.hips ? PHRASES.hips[look.hips] : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (shape) parts.push(`Specifically: ${shape}. Render this exactly, do not slim it down.`);

  const face = [
    look.faceShape ? `${humanise(look.faceShape)} face shape` : "",
    look.eyeColour ? `${humanise(look.eyeColour)} eyes` : "",
    look.skinTone ? `${humanise(look.skinTone)} skin` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (face) parts.push(`Face: ${face}.`);

  const hair = [
    look.hairLength ? `${humanise(look.hairLength)}` : "",
    look.hairColour ? `${humanise(look.hairColour)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (hair) parts.push(`Hair: ${hair}.`);

  if (look.style) parts.push(`Overall: ${PHRASES.style[look.style]}.`);

  // Last, and phrased as an instruction rather than a description, because this
  // is the one the writer is most likely to soften on its own.
  if (look.appeal) {
    parts.push(`Register: ${PHRASES.appeal[look.appeal]}.`);
    if (look.appeal === "sexy" || look.appeal === "bombshell") {
      parts.push(
        "Carry that through the face, the figure and the wardrobe together — a sexy figure " +
          "described in loose clothing comes back as an ordinary person.",
      );
    }
  }

  return parts.join(" ");
}

/** True when the operator has actually chosen something. */
export function hasLook(look: CreatorLook | null | undefined): boolean {
  return Boolean(look && Object.values(look).some(Boolean));
}
