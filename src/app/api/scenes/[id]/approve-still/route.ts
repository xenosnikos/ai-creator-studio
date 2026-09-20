import { fail, ok, route } from "@/lib/api";
import { assets, jobs, projects, scenes } from "@/lib/repo";
import { buildProjectView } from "@/lib/views";
import { visualFingerprint } from "@/lib/scene-fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Approve exactly the newest keyframe for this scene and creator. */
export const POST = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const scene = scenes.get(id);
  if (!scene) return fail("Scene not found", 404);
  const project = projects.get(scene.projectId);
  if (!project) return fail("Project not found", 404);
  if (!project.storyboardApprovedAt) {
    return fail("Approve the current script and shot list first.", 409);
  }
  if (jobs.isPendingForScene(scene.id, "scene_image", project.creatorId)) {
    return fail("Wait for this preview still to finish before approving it.", 409);
  }
  const image = assets.latestForScene(scene.id, "image", project.creatorId);
  if (!image) return fail("Generate a preview still for this scene first.", 409);
  if (image.meta?.visualFingerprint !== visualFingerprint(scene)) {
    return fail("This scene changed after the still was generated. Generate a new preview still.", 409);
  }

  scenes.approveImage(scene.id, image.id);
  return ok(buildProjectView(project.id));
});
