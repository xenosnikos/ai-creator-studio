import { assets, jobs, projects } from "@/lib/repo";
import type { Project } from "@/lib/types";

/**
 * Keep a project's status honest about what it has actually produced.
 *
 * The status was only ever written in two places — `storyboarded` when the
 * shot list landed, `rendering` when a batch was queued — and never again. So
 * `ready` existed in the type, had a green dot waiting for it on the projects
 * list, and could not be reached: a finished thirty-second video sat under a
 * pulsing "rendering" badge forever. The mirror image was worse. A render that
 * failed, or a process that died mid-batch, left the project claiming to be
 * rendering with nothing running, and the only way to clear it was to start
 * another render.
 *
 * The fix is to stop writing the status as a side effect of starting work and
 * instead derive it from the facts, every time a job for the project settles.
 * Derived state cannot go stale, and it self-heals: the crashed batch above
 * corrects itself the next time anything for that project finishes.
 */
export function settleProjectStatus(projectId: string | null | undefined): void {
  if (!projectId) return;
  try {
    const project = projects.get(projectId);
    if (!project) return;
    const next = statusOf(project);
    if (next !== project.status) projects.update(projectId, { status: next });
  } catch {
    // A status badge is not worth failing a finished render over.
  }
}

function statusOf(project: Project & { scenes: { id: string }[] }): Project["status"] {
  // Work in flight outranks everything: a re-render of one shot in a finished
  // project should read as rendering again, not as ready.
  if (jobs.anyPendingForProject(project.id)) return "rendering";
  if (project.scenes.length === 0) return "draft";
  return delivered(project) ? "ready" : "storyboarded";
}

/**
 * Has the project produced the thing it was asked for?
 *
 * Deliberately asks about the deliverable rather than about the scenes. A
 * video project is done when there is one video to download — that is the
 * whole point of the cut, and counting rendered clips instead would call a
 * project ready while it still hands back four files.
 */
function delivered(project: Project & { scenes: { id: string }[] }): boolean {
  if (project.settings.kind === "photo") {
    return project.scenes.every(
      (scene) => assets.latestForScene(scene.id, "image", project.creatorId) !== null,
    );
  }
  return assets
    .forProject(project.id)
    .some((asset) => asset.kind === "video" && asset.meta?.finalCut === true);
}
