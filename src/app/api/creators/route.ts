import { z } from "zod";

import { lookSchema } from "@/lib/look-schema";

import { generateIdentityBlock } from "@/lib/ai/identity";
import { ok, readJson, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { creators, jobs } from "@/lib/repo";
import { DEFAULT_VOICE, type VoiceConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const voiceSchema = z.object({
  provider: z.string().default(DEFAULT_VOICE.provider),
  voiceId: z.string().min(1),
  label: z.string().min(1),
  stability: z.number().min(0).max(1),
  similarityBoost: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speed: z.number().min(0.7).max(1.2),
  languageCode: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.string().max(60).default(""),
  persona: z.string().max(2000).default(""),
  /** Data URLs or https URLs of uploaded reference photos. */
  referenceImages: z.array(z.string()).max(10).default([]),
  /** Used when no photos are supplied, to steer the invented appearance. */
  appearanceNotes: z.string().max(2000).optional(),
  look: lookSchema.optional(),
  voice: voiceSchema.optional(),
  /** Kick off identity-sheet generation immediately after creation. */
  buildIdentitySheet: z.boolean().default(true),
});

export const GET = route(async () => ok({ creators: creators.list() }));

/**
 * Create a creator.
 *
 * Two paths converge here:
 *  - *imported* creators arrive with reference photos, which Claude reads into
 *    a locked identity block;
 *  - *synthetic* creators arrive with only a persona, so Claude invents the
 *    appearance and a bootstrap job renders the first frame.
 *
 * Either way the creator ends up with the same shape — identity block + anchor
 * references + locked voice — so nothing downstream needs to care which it was.
 */
export const POST = route(async (request: Request) => {
  const body = createSchema.parse(await readJson(request));

  const images = await Promise.all(
    body.referenceImages.map(async (source) => toImagePart(source)),
  );

  const identity = await generateIdentityBlock({
    name: body.name,
    category: body.category,
    persona: body.persona,
    images: images.filter((image): image is NonNullable<typeof image> => image !== null),
    appearanceNotes: body.appearanceNotes,
    look: body.look,
  });

  const voice: VoiceConfig = body.voice ?? DEFAULT_VOICE;
  const creator = creators.create({
    name: body.name,
    category: body.category,
    persona: body.persona,
    identity,
    voice,
    appearanceNotes: body.appearanceNotes,
    look: body.look,
  });

  // Persist the uploaded photos as seed references (the identity ground truth).
  const { persistReference } = await import("@/lib/creators/references");
  for (const source of body.referenceImages) {
    await persistReference({ creatorId: creator.id, source, kind: "seed", isAnchor: true });
  }

  if (body.referenceImages.length === 0) {
    // No photos: invent a first frame, then build the sheet from it.
    jobs.create({ type: "creator_bootstrap", creatorId: creator.id });
  }
  if (body.buildIdentitySheet) {
    jobs.create({ type: "identity_sheet", creatorId: creator.id });
  }
  scheduleTick();

  return ok({ creator: creators.get(creator.id) }, 201);
});

/** Accept either a data URL or a remote https URL and normalise to base64. */
async function toImagePart(
  source: string,
): Promise<{ mediaType: string; data: string } | null> {
  if (source.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(source);
    if (!match) return null;
    return { mediaType: match[1], data: match[2] };
  }
  if (!source.startsWith("http")) return null;
  const response = await fetch(source);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    mediaType: response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
    data: buffer.toString("base64"),
  };
}
