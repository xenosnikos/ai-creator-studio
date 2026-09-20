import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { cancellation } from "@/lib/repo";

/**
 * Cancel a job, or everything still pending for a project or creator.
 *
 * Worth being honest about what this does and does not do. A queued job is
 * stopped before it starts and costs nothing. A job already running has work in
 * flight at the provider that cannot be recalled — the render finishes and is
 * billed regardless; cancelling stops us waiting on it and stops the result
 * being written. It buys back your time, not your credits.
 */
const bulkSchema = z.object({
  projectId: z.string().optional(),
  creatorId: z.string().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export const POST = route(async (request: Request, { params }: Params) => {
  const { id } = await params;

  // `all` is the "stop everything" button; any other id cancels one job.
  if (id === "all") {
    const body = bulkSchema.parse(await readJson(request).catch(() => ({})));
    if (!body.projectId && !body.creatorId) {
      return fail("Pass a projectId or creatorId to cancel pending work for.", 400);
    }
    return ok({ cancelled: cancellation.cancelPending(body) });
  }

  const job = cancellation.cancel(id);
  if (!job) return fail("Job not found", 404);
  return ok({ job });
});
