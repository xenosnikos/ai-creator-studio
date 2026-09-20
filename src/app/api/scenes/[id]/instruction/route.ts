import { z } from "zod";

import { parseInstruction } from "@/lib/ai/storyboard";
import { fail, ok, readJson, route } from "@/lib/api";
import { creators, projects, scenes } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const postSchema = z.object({
  instruction: z.string().min(3).max(1000),
  /** Persist the parsed result onto the scene. */
  apply: z.boolean().default(true),
});

/**
 * Instruction control.
 *
 * Turns director shorthand — "Medium shot, smiling, holding coffee, sunrise
 * lighting, cinematic" — into a complete structured shot spec, so the operator
 * gets both the convenience of free text and the reproducibility of explicit
 * camera / expression / pose / lighting / mood fields.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const scene = scenes.get(id);
  if (!scene) return fail("Scene not found", 404);

  const project = projects.get(scene.projectId);
  if (!project) return fail("Project not found", 404);
  const creator = creators.get(project.creatorId);
  if (!creator) return fail("Creator not found", 404);

  const body = postSchema.parse(await readJson(request));
  const spec = await parseInstruction({
    instruction: body.instruction,
    creator,
    base: scene.spec,
  });

  if (body.apply) {
    const updated = scenes.update(id, { spec });
    return ok({ scene: updated, spec });
  }
  return ok({ scene, spec });
});
