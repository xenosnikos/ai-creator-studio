import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { creators, jobs, projects, scenes } from "@/lib/repo";
import { buildProjectView } from "@/lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const swapSchema = z.object({
  creatorId: z.string().min(1),
  /**
   * `replace` re-points the project at the new creator (the storyboard, shot
   * list, dialogue and transcript are untouched). `compare` leaves the project
   * as-is and renders a parallel set of assets for the new creator so the two
   * can be viewed side by side.
   */
  mode: z.enum(["replace", "compare"]).default("compare"),
  stages: z.array(z.enum(["image", "voice", "video"])).min(1).default(["image"]),
  sceneIds: z.array(z.string()).optional(),
});

/**
 * Character swap.
 *
 * The whole operation is a creator substitution — nothing about the scenes is
 * regenerated. That is possible because storyboards are stored creator-agnostic
 * (the subject is the literal `{CREATOR}` token) and the prompt compiler is the
 * only place the two are combined.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return fail("Project not found", 404);
  if (project.scenes.length === 0) {
    return fail("Generate the storyboard before swapping creators.", 409);
  }
  if (!project.storyboardApprovedAt) {
    return fail("Approve the script and shot list before generating comparison stills.", 409);
  }

  const body = swapSchema.parse(await readJson(request));
  if (body.stages.some((stage) => stage !== "image")) {
    return fail(
      "Creator comparison is a preview-still step. Replace the creator, review the new stills, and approve them before generating video.",
      409,
    );
  }
  const creator = creators.get(body.creatorId);
  if (!creator) return fail("Creator not found", 404);
  if (creator.references.length === 0) {
    return fail(
      `"${creator.name}" has no reference images yet. Build their identity sheet before swapping.`,
      409,
    );
  }

  if (body.mode === "replace") {
    projects.update(id, { creatorId: body.creatorId });
  }

  const targetScenes = body.sceneIds
    ? project.scenes.filter((scene) => body.sceneIds!.includes(scene.id))
    : project.scenes;

  const created = [];
  for (const stage of ["image", "voice", "video"] as const) {
    if (!body.stages.includes(stage)) continue;
    for (const scene of targetScenes) {
      if (stage === "voice" && !scene.dialogue.trim()) continue;
      scenes.clearImageApproval(scene.id);
      created.push(
        jobs.create({
          type:
            stage === "image" ? "scene_image" : stage === "video" ? "scene_video" : "scene_voice",
          projectId: id,
          sceneId: scene.id,
          creatorId: body.creatorId,
          payload: { creatorId: body.creatorId },
        }),
      );
    }
  }

  scheduleTick();
  return ok({ jobs: created, view: buildProjectView(id) }, 202);
});
