import { z } from "zod";

import { lookSchema } from "@/lib/look-schema";

import { generateIdentityBlock } from "@/lib/ai/identity";
import { fail, ok, readJson, route } from "@/lib/api";
import { creators } from "@/lib/repo";
import { readAsset } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const postSchema = z.object({
  /** Replaces the stored brief. Omit to re-run the existing one. */
  appearanceNotes: z.string().max(2000).optional(),
  /** Replaces the stored picks. Omit to re-run the existing ones. */
  look: lookSchema.optional(),
});

/**
 * Rewrite a creator's identity block from their appearance brief.
 *
 * The brief used to be consumed once at creation and discarded, so "that is not
 * the person I described" had no remedy short of deleting the creator and
 * starting again — losing the voice, the seed and every render already made
 * against them. Now the brief is stored, editable, and re-runnable in place.
 *
 * The creator's reference photos, if any, are read again too: the block is
 * meant to describe the person in the photos, steered by the brief.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const creator = creators.get(id);
  if (!creator) return fail("Creator not found", 404);

  const body = postSchema.parse(await readJson(request).catch(() => ({})));
  const appearanceNotes = body.appearanceNotes ?? creator.appearanceNotes;
  const look = body.look ?? creator.look;

  const seeds = creator.references.filter((ref) => ref.kind === "seed" && ref.localPath);
  const images = [];
  for (const ref of seeds.slice(0, 4)) {
    try {
      const bytes = await readAsset(ref.localPath!);
      images.push({
        mediaType: ref.localPath!.endsWith(".png") ? "image/png" : "image/jpeg",
        data: bytes.toString("base64"),
      });
    } catch {
      // A reference we cannot read is one the model simply does not see; the
      // brief still carries the description.
    }
  }

  const identity = await generateIdentityBlock({
    name: creator.name,
    category: creator.category,
    persona: creator.persona,
    images,
    appearanceNotes,
    look,
  });

  const updated = creators.update(id, { identity, appearanceNotes, look });
  return ok({ creator: updated });
});
