import { z } from "zod";

import { rm } from "node:fs/promises";

import { ok, readJson, route } from "@/lib/api";
import { creators } from "@/lib/repo";
import { absoluteAssetPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; refId: string }> };

const patchSchema = z.object({ isAnchor: z.boolean() });

/** Toggle whether a reference is fed to the model as an identity anchor. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id, refId } = await params;
  const body = patchSchema.parse(await readJson(request));
  creators.setAnchor(refId, body.isAnchor);
  return ok({ references: creators.references(id) });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { id, refId } = await params;
  // Read the path before the row goes, or there is no way left to find the
  // file. Deleting a reference photo should delete the photo.
  const stored = creators.references(id).find((reference) => reference.id === refId)?.localPath;
  creators.removeReference(refId);
  if (stored) {
    try {
      await rm(absoluteAssetPath(stored), { force: true });
    } catch {
      // Traversal guard or a missing file — neither is a failed deletion.
    }
  }
  return ok({ references: creators.references(id) });
});
