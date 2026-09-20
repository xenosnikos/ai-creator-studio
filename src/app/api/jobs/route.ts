import { ok, route } from "@/lib/api";
import { jobs } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Job status feed. The UI polls this to drive progress bars; scoping by
 * project or creator keeps the payload small.
 */
export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const creatorId = url.searchParams.get("creatorId");

  if (projectId) return ok({ jobs: jobs.forProject(projectId) });
  if (creatorId) return ok({ jobs: jobs.forCreator(creatorId) });
  return ok({ jobs: jobs.active() });
});
