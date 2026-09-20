import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { persistReference } from "@/lib/creators/references";
import { creators } from "@/lib/repo";
import { IDENTITY_ANGLES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const postSchema = z.object({
  /** Data URLs from the browser file picker, or existing https URLs. */
  images: z.array(z.string()).min(1).max(10),
  angle: z.enum(IDENTITY_ANGLES).nullable().default(null),
  isAnchor: z.boolean().default(true),
});

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return ok({ references: creators.references(id) });
});

/** Add more ground-truth reference photos to an existing creator. */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  if (!creators.get(id)) return fail("Creator not found", 404);

  const body = postSchema.parse(await readJson(request));
  const added = [];
  for (const source of body.images) {
    added.push(
      await persistReference({
        creatorId: id,
        source,
        kind: "seed",
        angle: body.angle,
        isAnchor: body.isAnchor,
      }),
    );
  }
  return ok({ references: added }, 201);
});
