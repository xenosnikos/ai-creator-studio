import { sized } from "@/lib/asset-url";
import Link from "next/link";

import { DeleteButton } from "@/components/DeleteButton";
import { assets, creators, projects } from "@/lib/repo";
import { publicUrlFor } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Status colours, so a glance down the list tells you where everything is. */
const STATUS_DOT: Record<string, string> = {
  draft: "dot",
  storyboarded: "dot dot-warn",
  rendering: "dot dot-live",
  ready: "dot dot-ok",
};

export default function ProjectsPage() {
  const all = projects.list();

  return (
    <div className="space-y-7">
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">
            A project is one brief plus everything it produced — storyboard, script, voice and
            renders. Swap the creator at any point and the scenes survive untouched.
          </p>
        </div>
        <Link href="/projects/new" className="btn btn-primary shrink-0">
          New project
        </Link>
      </div>

      {all.length === 0 ? (
        <div className="empty">
          <div className="max-w-sm space-y-3">
            <p className="text-base font-medium">Nothing in production</p>
            <p className="text-sm leading-relaxed text-muted">
              Write a brief in plain English — where they are, what they are talking about — and
              it becomes a shot-by-shot storyboard with a script to match.
            </p>
            <div className="flex justify-center pt-1">
              <Link href="/projects/new" className="btn btn-primary">
                Start a project
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {all.map((project) => {
            const creator = creators.get(project.creatorId);
            // A thumbnail of the newest render, so the list is scannable by
            // picture rather than by title alone.
            const shot = assets
              .forProject(project.id)
              .filter((asset) => asset.kind === "image")
              .at(-1);

            return (
              <div key={project.id} className="group relative">
                <Link
                  href={`/projects/${project.id}`}
                  className="card-interactive flex items-stretch gap-4 overflow-hidden pr-12"
                >
                  <div className="card-media aspect-[3/4] w-[68px] shrink-0">
                    {shot ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sized(publicUrlFor(shot.localPath), 320) || (shot.remoteUrl ?? "")}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-raised" />
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-3">
                    <div className="flex items-center gap-2">
                      <span className={STATUS_DOT[project.status] ?? "dot"} aria-hidden />
                      <p className="truncate font-medium tracking-[-0.01em]">{project.title}</p>
                    </div>
                    <p className="line-clamp-1 text-xs text-muted">{project.prompt}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-faint">
                      <span>{creator?.name ?? "deleted creator"}</span>
                      <span aria-hidden>·</span>
                      {/* A photo set has no duration; showing seconds on one
                          described what a video would have done instead. */}
                      <span>
                        {project.settings.kind === "photo"
                          ? `${project.settings.photoCount} image${project.settings.photoCount === 1 ? "" : "s"}`
                          : `${project.settings.targetDurationSeconds}s`}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{project.settings.aspectRatio}</span>
                      <span aria-hidden>·</span>
                      <span className="capitalize">{project.status}</span>
                    </div>
                  </div>
                </Link>
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <DeleteButton
                    endpoint={`/api/projects/${project.id}`}
                    label={`Delete ${project.title}`}
                    confirmText={`Delete "${project.title}" and everything rendered for it?`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
