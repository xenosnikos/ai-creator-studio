import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { creators, jobs } from "@/lib/repo";
import { IDENTITY_ANGLES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const postSchema = z.object({
  /** Regenerate only these angles; omit for the full sheet. */
  angles: z.array(z.enum(IDENTITY_ANGLES)).min(1).optional(),
  /** When false, keep existing sheet shots instead of clearing them. */
  replace: z.boolean().default(true),
});

/**
 * Build (or rebuild) the creator's canonical multi-angle identity sheet.
 * This is both the consistency proof surface and the anchor pool that scene
 * renders draw from.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const creator = creators.get(id);
  if (!creator) return fail("Creator not found", 404);

  const body = postSchema.parse(await readJson(request).catch(() => ({})));
  if (creator.references.filter((ref) => ref.kind === "seed").length === 0) {
    return fail(
      "This creator has no seed reference images yet. Upload photos or wait for the bootstrap render to finish.",
      409,
    );
  }

  // Same reasoning as the scene render route: a second click while the first
  // sheet is still building bills for a duplicate set of renders, and with
  // `replace: true` the two runs also race to clear each other's output.
  if (jobs.isPendingForCreator(id, "identity_sheet")) {
    return ok({ job: null, skipped: true, message: "A sheet is already building." }, 202);
  }

  const job = jobs.create({
    type: "identity_sheet",
    creatorId: id,
    payload: { angles: body.angles, replace: body.replace },
  });
  scheduleTick();
  return ok({ job }, 202);
});
