/**
 * Sample creators and an example project.
 *
 * The identity blocks here are hand-written rather than LLM-generated, so
 * seeding works with no API key and produces the same creators every time.
 * They also double as a reference for what a *good* identity block looks like:
 * specific, purely physical, and committed rather than hedged.
 *
 * Seeded creators have no reference images yet — open one and hit "Rebuild
 * identity sheet" to generate their six canonical angles.
 */

import { EXAMPLE_PROMPTS } from "@/lib/examples";
import { creators, projects } from "@/lib/repo";
import type { IdentityBlock, VoiceConfig } from "@/lib/types";

interface Sample {
  name: string;
  category: string;
  persona: string;
  identity: IdentityBlock;
  voice: VoiceConfig;
}

const SAMPLES: Sample[] = [
  {
    name: "Mia Tanaka",
    category: "Travel & food",
    persona:
      "Fast-talking city guide who grew up between Osaka and Vancouver. Opinionated about food, allergic to tourist traps. Speaks in short, punchy sentences and always names a specific place.",
    identity: {
      canonical:
        "A woman in her late twenties with a heart-shaped face, a softly pointed chin and wide-set dark brown almond eyes under straight, low-arched brows. Small straight nose with a slightly rounded tip, medium-full lips with a defined cupid's bow, and high flat cheekbones. Collarbone-length straight black hair with a blunt cut and a full fringe sitting just above the brows. Light-medium skin with a warm golden undertone and a faint natural flush across the cheeks. Petite and slim with narrow shoulders, a short torso and an upright, forward-leaning posture.",
      face: "Heart-shaped face, softly pointed chin, wide-set dark brown almond eyes, straight low-arched brows, small straight nose, medium-full lips with defined cupid's bow, high flat cheekbones.",
      hair: "Collarbone-length straight black hair, blunt cut, full fringe just above the brows.",
      skinTone: "Light-medium with a warm golden undertone, faint natural flush on the cheeks.",
      bodyType: "Petite and slim, narrow shoulders, short torso, upright forward-leaning posture.",
      distinguishingFeatures: "A small silver hoop in the left ear cartilage.",
      wardrobe:
        "Oversized cream linen shirt over a black tank, wide-leg dark denim, chunky white trainers.",
      negative:
        "rounded jaw, wider-set nose, brown or dyed hair, hair without a fringe, taller or broader build, heavy makeup",
    },
    voice: {
      provider: "kie:elevenlabs",
      voiceId: "FGY2WhTYpPnrIDTdsKH5",
      label: "Elli — youthful, energetic (F)",
      stability: 0.7,
      similarityBoost: 0.85,
      style: 0.25,
      speed: 1.08,
    },
  },
  {
    name: "Daniel Okonkwo",
    category: "Finance & business",
    persona:
      "Former buy-side analyst turned educator. Calm, precise, allergic to hype. Explains one idea per video and always states the counter-argument before the conclusion.",
    identity: {
      canonical:
        "A man in his late thirties with a broad oval face, a strong square jaw and a defined chin cleft. Deep-set dark brown eyes beneath thick straight brows, a broad nose with a rounded tip, and full lips. Closely cropped black hair faded at the sides with a sharp hairline, and a neatly trimmed short full beard connecting to the sideburns. Deep brown skin with a neutral undertone and an even matte complexion. Tall with a broad-shouldered athletic build, long limbs and a squared, still posture.",
      face: "Broad oval face, strong square jaw, defined chin cleft, deep-set dark brown eyes, thick straight brows, broad nose with rounded tip, full lips.",
      hair: "Closely cropped black hair faded at the sides, sharp hairline, neatly trimmed short full beard.",
      skinTone: "Deep brown, neutral undertone, even matte complexion.",
      bodyType: "Tall, broad-shouldered athletic build, long limbs, squared still posture.",
      distinguishingFeatures: "",
      wardrobe:
        "Charcoal merino quarter-zip, navy tailored trousers, a simple steel watch on the left wrist.",
      negative:
        "clean-shaven, long hair, narrow or soft jaw, lighter skin tone, slender build, glasses",
    },
    voice: {
      provider: "kie:elevenlabs",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      label: "Bradford — deep, authoritative (M)",
      stability: 0.85,
      similarityBoost: 0.9,
      style: 0.05,
      speed: 0.95,
    },
  },
  {
    name: "Sofia Marchetti",
    category: "Wellness & lifestyle",
    persona:
      "Ex-physiotherapist who makes recovery and sleep unglamorous and practical. Warm but blunt. Never sells supplements; always gives the free version first.",
    identity: {
      canonical:
        "A woman in her mid-thirties with a long oval face, a straight narrow nose with a slight dorsal bump, and green-hazel deep-set eyes under gently arched brows. High angular cheekbones, a narrow jaw and thin-to-medium lips with a flat cupid's bow. Long wavy auburn hair falling past the shoulders, centre-parted, with lighter sun-bleached ends. Fair skin with a cool pink undertone and an even complexion. Medium height with a lean, long-limbed build, square shoulders and a relaxed open posture.",
      face: "Long oval face, straight narrow nose with slight dorsal bump, deep-set green-hazel eyes, gently arched brows, high angular cheekbones, narrow jaw, thin-to-medium lips.",
      hair: "Long wavy auburn hair past the shoulders, centre-parted, sun-bleached ends.",
      skinTone: "Fair with a cool pink undertone, even complexion, visible fine pores across the nose.",
      bodyType: "Medium height, lean long-limbed build, square shoulders, relaxed open posture.",
      distinguishingFeatures: "",
      wardrobe: "Sage-green ribbed long-sleeve top, soft grey wide trousers, bare feet or trainers.",
      negative:
        "dark brown or black hair, straight hair, tanned or olive skin, round face, brown eyes",
    },
    voice: {
      provider: "kie:elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      label: "Dorothy — soft, reassuring (F)",
      stability: 0.8,
      similarityBoost: 0.85,
      style: 0.1,
      speed: 0.97,
    },
  },
];

export interface SeedResult {
  seeded: boolean;
  creators: string[];
  projectId?: string;
}

/**
 * Populate an empty studio. No-op when any creator or project already exists,
 * so it is safe to call on every boot — which is how a fresh `docker run` or a
 * new hosted deployment comes up with something to look at instead of an empty
 * screen.
 */
export function seedIfEmpty(): SeedResult {
  if (creators.list().length > 0 || projects.list().length > 0) {
    return { seeded: false, creators: [] };
  }

  const created = SAMPLES.map((sample) =>
    creators.create({
      name: sample.name,
      category: sample.category,
      persona: sample.persona,
      identity: sample.identity,
      voice: sample.voice,
      status: "draft",
    }),
  );

  const example = EXAMPLE_PROMPTS[0];
  const project = projects.create({
    title: "Tokyo ramen guide",
    prompt: example.prompt,
    creatorId: created[0].id,
    settings: {
      aspectRatio: "9:16",
      imageQuality: "high",
      targetDurationSeconds: example.duration,
      kind: "video",
      photoCount: 4,
      videoResolution: "720p",
      audioMode: "lipsync",
      look: "social",
      globalStyle: example.globalStyle,
    },
  });

  return {
    seeded: true,
    creators: created.map((creator) => creator.name),
    projectId: project.id,
  };
}
