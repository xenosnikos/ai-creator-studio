import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { creators, jobs } from "@/lib/repo";
import { removeAssetFolder } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  category: z.string().max(60).optional(),
  persona: z.string().max(2000).optional(),
  // The identity block is editable on purpose: an operator who spots drift
  // should be able to tighten the description rather than start over.
  identity: z
    .object({
      canonical: z.string().min(20),
      face: z.string(),
      hair: z.string(),
      skinTone: z.string(),
      bodyType: z.string(),
      distinguishingFeatures: z.string(),
      wardrobe: z.string(),
      negative: z.string(),
    })
    .optional(),
  voice: z
    .object({
      provider: z.string(),
      voiceId: z.string().min(1),
      label: z.string().min(1),
      stability: z.number().min(0).max(1),
      similarityBoost: z.number().min(0).max(1),
      style: z.number().min(0).max(1),
      speed: z.number().min(0.7).max(1.2),
      languageCode: z.string().optional(),
    })
    .optional(),
});

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const creator = creators.get(id);
  // Jobs travel with the creator because the page derives live state from
  // them — an empty sheet tile means "generating" while a sheet job is in
  // flight and "not made yet" once it is not. Without them here the page kept
  // whatever job list the server rendered with and never moved off it.
  return creator ? ok({ creator, jobs: jobs.forCreator(id) }) : fail("Creator not found", 404);
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const patch = patchSchema.parse(await readJson(request));
  const creator = creators.update(id, patch);
  return creator ? ok({ creator: creators.get(id) }) : fail("Creator not found", 404);
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  creators.remove(id);
  // Reference photos, the identity sheet and every seed render, all of which
  // live under one folder named after the creator.
  await removeAssetFolder(`creators/${id}`);
  return ok({ deleted: true });
});
