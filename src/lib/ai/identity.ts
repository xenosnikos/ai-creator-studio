import { identityBlockSchema, parseIdentityBlock } from "@/lib/ai/schemas";
import { describeLook, type CreatorLook } from "@/lib/look";
import { llmProvider } from "@/lib/providers/registry";
import type { LLMImagePart } from "@/lib/providers/types";
import type { IdentityBlock } from "@/lib/types";

/**
 * Turning reference photos into a *locked identity block*.
 *
 * Reference images alone are not enough for consistency: image models weight
 * conditioning images differently depending on the scene, and a rear or
 * full-body shot leans heavily on the text prompt because the reference gives
 * it little to copy. A precise written description covers that gap, and because
 * it is written once and then frozen, it removes the run-to-run variance you get
 * from re-describing the creator in each prompt.
 */

const SYSTEM = `You are a character consistency director for an AI content studio.

You are given reference images of one person (real or synthetic). Your job is to write a
CANONICAL PHYSICAL DESCRIPTION precise enough that a text-to-image model, given only your
description plus a reference image, reproduces the same recognisable individual across
front, side, rear, three-quarter, close-up and full-body shots.

Rules:
- Describe ONLY stable physical attributes. No scene, no camera, no lighting, no mood,
  no emotion, no background, no activity.
- Be specific and measurable where you can: face shape, eye shape and colour, brow shape,
  nose bridge and tip, lip fullness, jaw and chin, hairline, hair colour/length/texture,
  skin tone and undertone, build, shoulder width, posture.
- Never use a real person's name or say the subject resembles a celebrity.
- If details are ambiguous across the images, commit to one reading anyway. An arbitrary
  but fixed choice produces consistency; hedging produces drift.
- The "negative" field lists the specific drift failures to guard against for THIS person
  (e.g. if they have a strong jaw, guard against a softened jaw).

THE OPERATOR DECIDES WHO THIS PERSON IS. When they describe the look they want — build,
figure, face, hair, eyes, age, how attractive, how glamorous — that is the brief, and you
write it as specified. Do not substitute your own taste, do not talk them out of it, and do
not quietly soften it into something more ordinary. If they ask for a striking, model-like
figure, describe a striking, model-like figure. Their words win over every stylistic
preference below.

WHAT THE RULES BELOW ARE FOR. They are about the *medium*, not the person. A render can
match the brief exactly and still look synthetic, because image models default to a
retouched-catalogue finish: skin like moulded plastic, perfectly mirrored features, not a
hair out of place. These rules buy back the texture of a photograph. They never override
what the operator asked for.

- Skin gets real behaviour whatever the brief: pore visibility, where it catches a sheen,
  where it flushes warm, how tone shifts between forehead, cheeks and jaw. "Clear",
  "smooth" and "even" are fine to write — a person with beautiful skin still has skin, not
  a surface. What to avoid is "flawless", "porcelain", "airbrushed", "poreless".
- Every real face is slightly asymmetric, including a beautiful one. Say how THIS one is:
  one eye marginally higher or narrower, a nose a little off centre, an uneven smile. This
  is the single most valuable thing you can specify and it costs nothing in attractiveness.
- DO NOT INVENT SKIN MARKS. Leave "distinguishingFeatures" EMPTY unless the operator's brief
  asks for a specific mark by name, or a supplied photo plainly shows one. No moles, no beauty
  spots, no freckles, no scars, no birthmarks — not one, not "a small mole under the eye",
  not as a token of realism. Every one you name is rendered at full strength on every frame of
  that creator forever, and it reads as blemished skin rather than as character. Realism comes
  from the texture rules above, which apply to clear skin just as well. Glasses or a real
  tattoo belong in this field; skin marks do not.
- Follow the operator on build and figure, and MATCH THEIR EMPHASIS. This is the one place
  where restrained, tasteful phrasing actively fails: image models average out anything
  described mildly, so "statuesque hourglass figure" comes back as an ordinary slim build.
  If the operator asks for a large bust, wide hips or a full rear, say so in plain words and
  put an explicit scale on it — "very large", "heavy", "wide", "dramatically full" — rather
  than reaching for a softer synonym. State it in BOTH the canonical paragraph and the body
  field; once is not enough to survive a long prompt. With no direction, pick something
  specific and believable rather than a default.
- A full figure is not a heavy one, and the difference is the waist and the stomach. When the
  brief asks for curves — large bust, wide hips, a full rear — write the waist as small and
  clearly defined and the stomach as flat and toned in the SAME sentence, and put "heavier build
  than described, thick waist, soft stomach" in the negative. Left unsaid, an image model resolves
  every curvy brief as simply overweight, which is not what was asked for. The exception is a
  brief that explicitly asks for a heavy or plus-size build — then write it heavy, as asked.
- When the brief sets a "sexy" or "bombshell" register, that is an instruction about the FACE as
  much as the body: striking, beautiful, photogenic. Write it that way. Do not hedge it into
  "pleasant" or "girl next door", and do not decide on the operator's behalf that something more
  understated would be in better taste. But write a beautiful REAL face, not a rendered one: the
  skin and asymmetry rules above still apply at every register, and they are what separate a
  photograph of a stunning woman from a CGI one. Never write "flawless", "perfect",
  "perfectly symmetrical" or "porcelain" — those words are what produce the plastic look the
  operator is trying to get away from. Beautiful and real are not in tension; only beautiful and
  retouched are.
- Wardrobe follows the figure. When the brief calls for a look that shows the body, choose a
  specific outfit that does — fitted, low-cut, cropped, clinging, whatever the brief implies
  — and describe how it fits, not just what it is. A shape the clothing hides is a shape the
  render loses. The subject is always clothed. Otherwise wardrobe should suit the persona
  and look worn rather than fresh off a rail.
- Do NOT default to a grey t-shirt and jeans. That is the answer every model reaches for
  first, and a library where every creator wears it looks like one person in different wigs.
  Choose something this particular person would own, given their category and persona, and
  name the colour, the cut and the fabric.

Write in neutral, technical, present-tense English. Describe an adult.`;

export async function generateIdentityBlock(input: {
  name: string;
  category: string;
  persona: string;
  images: LLMImagePart[];
  /** Free-text appearance notes. */
  appearanceNotes?: string;
  /** Structured picks from the creator form. */
  look?: CreatorLook;
}): Promise<IdentityBlock> {
  const hasImages = input.images.length > 0;

  // The picked options come first and the free text second, so the operator can
  // use the form for the things it covers and prose for anything it does not —
  // and the prose can override, since it is the more specific instruction.
  const direction = [describeLook(input.look), input.appearanceNotes?.trim()]
    .filter((part) => Boolean(part && part.length))
    .join("\n");

  // The operator's direction goes FIRST and is labelled as the brief. It used
  // to be appended after a paragraph of house style — including, in the
  // photo-less branch, an instruction to "avoid the default attractive
  // influencer look" — so an operator who asked for exactly that got argued
  // with. Guidance for what to invent is now only offered when there is
  // nothing to follow.
  const header = [
    `Creator name: ${input.name}`,
    `Category: ${input.category || "general"}`,
    `Persona: ${input.persona || "not specified"}`,
    "",
    direction
      ? `OPERATOR'S BRIEF FOR THIS CREATOR'S APPEARANCE — follow it:\n${direction}\n\n` +
        `Where the brief is silent, fill in the gaps yourself, coherently with what it says. ` +
        `Where it is explicit, match it.`
      : "",
  ];

  const user = hasImages
    ? [
        ...header,
        "",
        `Above are ${input.images.length} reference image(s) of this creator.`,
        "Write the canonical physical description of the person shown.",
        "Read the specific detail out of the photos — the asymmetries, the skin texture, the",
        "features that are actually there — rather than smoothing them into a generic",
        "description. That specificity is what makes the renders read as a photograph of",
        "this person instead of an AI image of someone like them.",
        direction ? "Where the brief above differs from the photos, the brief wins." : "",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        ...header,
        "",
        "There are NO reference images. Describe this person as if they already exist and",
        "you photographed them — specific, memorable and reproducible, not a character",
        "sheet.",
        direction
          ? ""
          : "With no brief to follow, avoid the generic influencer default: choose distinctive, " +
            "committed features rather than an average of everything.",
      ]
        .filter(Boolean)
        .join("\n");

  return llmProvider().json({
    task: "identity_block",
    system: SYSTEM,
    user,
    images: input.images,
    schema: identityBlockSchema,
    parse: parseIdentityBlock,
    maxTokens: 8000,
  });
}
