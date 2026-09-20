import { fail, ok, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { jobs, projects } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** (Re)generate the storyboard, shot list, dialogue and transcript. */
export const POST = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return fail("Project not found", 404);

  const job = jobs.create({
    type: "storyboard",
    projectId: id,
    creatorId: project.creatorId,
  });
  scheduleTick();
  return ok({ job }, 202);
});
