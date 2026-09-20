import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { assets, creators, jobs, projects, scenes } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const renderSchema = z.object({
  /**
   * Which stages to run. Order is meaningful: video depends on the keyframe
   * image, so requesting both queues them in the right sequence.
   */
  stages: z
    .array(z.enum(["image", "voice", "video", "cut"]))
    .min(1)
    .default(["image"]),
  /** Limit to specific scenes; omit for the whole project. */
  sceneIds: z.array(z.string()).optional(),
  /**
   * Render as a different creator without touching the project's own creator.
   * This is the character-swap path: same scenes, same prompts, new identity.
   */
  creatorId: z.string().optional(),
});

export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return fail("Project not found", 404);
  if (project.scenes.length === 0) {
    return fail("Generate the storyboard before rendering.", 409);
  }

  const body = renderSchema.parse(await readJson(request).catch(() => ({})));
  const creatorId = body.creatorId ?? project.creatorId;
  const creator = creators.get(creatorId);
  if (!creator) return fail("Creator not found", 404);
  if (creator.references.length === 0) {
    return fail(
      `"${creator.name}" has no reference images yet, so identity cannot be preserved. Build the identity sheet first.`,
      409,
    );
  }

  /**
   * Re-join the shots that already exist, and nothing else.
   *
   * The cut is pure ffmpeg over clips that are already paid for, so re-running
   * it is free — and it is the only way to recover from something going wrong
   * in the assembly rather than in a render. A music bed that 402'd on the
   * wrong API key is the case that prompted this: the clips were perfect, the
   * bed was missing, and the only route back to a scored video was to
   * re-render a clip purely to make the cut re-queue behind it.
   */
  if (body.stages.includes("cut")) {
    if (body.stages.length > 1) {
      return fail("Rebuilding the video is its own step — request it on its own.", 409);
    }
    if (jobs.isPendingForProject(id, "project_cut")) {
      return ok({ jobs: [], skipped: 1 }, 202);
    }
    const job = jobs.create({ type: "project_cut", projectId: id, creatorId });
    scheduleTick();
    return ok({ jobs: [job], skipped: 0 }, 202);
  }

  const targetScenes = body.sceneIds
    ? project.scenes.filter((scene) => body.sceneIds!.includes(scene.id))
    : project.scenes;
  if (targetScenes.length === 0) return fail("No matching scenes", 400);

  const wantsPreview = body.stages.includes("image");
  const wantsProduction = body.stages.includes("voice") || body.stages.includes("video");
  if (wantsPreview && wantsProduction) {
    return fail(
      "Preview stills and video production are separate approval steps. Generate the stills, review and approve them, then generate the clips.",
      409,
    );
  }
  if (wantsPreview && !project.storyboardApprovedAt) {
    return fail("Approve the script and shot list before generating preview stills.", 409);
  }
  if (wantsProduction) {
    if (!project.storyboardApprovedAt) {
      return fail("Approve the current script and shot list before video generation.", 409);
    }
    const unapproved = targetScenes.find((scene) => {
      const latest = assets.latestForScene(scene.id, "image", creatorId);
      return !latest || scene.approvedImageAssetId !== latest.id;
    });
    if (unapproved) {
      return fail(
        `Approve the current preview still for scene ${unapproved.index + 1} before video generation.`,
        409,
      );
    }
  }

  const created = [];
  let skipped = 0;
  // Stage-major ordering: every keyframe is queued before any video, so the
  // video jobs find their source image already rendered.
  for (const stage of ["image", "voice", "video"] as const) {
    if (!body.stages.includes(stage)) continue;
    const type =
      stage === "image" ? "scene_image" : stage === "video" ? "scene_video" : "scene_voice";
    for (const scene of targetScenes) {
      if (stage === "voice" && !scene.dialogue.trim()) continue;
      // Queueing the same render twice bills twice for an identical result.
      // A double-click on "Render everything" used to do exactly that across
      // every scene at once, which is the most expensive way to notice.
      if (jobs.isPendingForScene(scene.id, type, creatorId)) {
        skipped += 1;
        continue;
      }
      if (stage === "image") scenes.clearImageApproval(scene.id);
      created.push(
        jobs.create({
          type,
          projectId: id,
          sceneId: scene.id,
          creatorId,
          payload: { creatorId },
        }),
      );
    }
  }

  if (created.length > 0) {
    projects.update(id, { status: "rendering" });
    scheduleTick();
  }
  return ok({ jobs: created, skipped }, 202);
});
