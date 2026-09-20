import { fail, ok, route } from "@/lib/api";
import { projects } from "@/lib/repo";
import { buildProjectView } from "@/lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Explicit cost gate between editable planning and preview-image generation. */
export const POST = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return fail("Project not found", 404);
  if (project.scenes.length === 0) return fail("Generate the storyboard first.", 409);

  projects.approveStoryboard(id);
  return ok(buildProjectView(id));
});
