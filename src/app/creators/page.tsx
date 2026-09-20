import { sized } from "@/lib/asset-url";
import Link from "next/link";

import { DeleteButton } from "@/components/DeleteButton";
import { creators, projects } from "@/lib/repo";
import { publicUrlFor } from "@/lib/storage";
import { DEFAULT_IDENTITY_ANGLES } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The creator library: every reusable identity kit in one place. */
export default function CreatorsPage() {
  const all = creators.list();
  // Deleting a creator cascades to their projects (projects.creator_id is
  // ON DELETE CASCADE), so the confirmation has to say how many go with them.
  // It previously promised the opposite — that projects survive — which would
  // have cost somebody a day's renders.
  const projectCount = new Map<string, number>();
  for (const project of projects.list()) {
    projectCount.set(project.creatorId, (projectCount.get(project.creatorId) ?? 0) + 1);
  }

  return (
    <div className="space-y-7">
      <div className="page-head">
        <div>
          <h1 className="page-title">Creator library</h1>
          <p className="page-subtitle">
            Each creator is a reusable identity kit — a locked description, anchor references,
            an angle sheet and a fixed voice. Build one once and every project can cast it.
          </p>
        </div>
        <Link href="/creators/new" className="btn btn-primary shrink-0">
          New creator
        </Link>
      </div>

      {all.length === 0 ? (
        <div className="empty">
          <div className="max-w-sm space-y-3">
            <p className="text-base font-medium">No creators yet</p>
            <p className="text-sm leading-relaxed text-muted">
              Describe someone and the studio will invent them, or upload photos of a face you
              already have. Either way you get the same identity kit at the end.
            </p>
            <div className="flex justify-center gap-2 pt-1">
              <Link href="/creators/new" className="btn btn-primary">
                Create a creator
              </Link>
            </div>
            <p className="help pt-1">
              Or run <span className="font-mono text-slate-300">npm run seed</span> for the
              sample creators.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {all.map((creator) => {
            const cover =
              creator.references.find((ref) => ref.kind === "sheet" && ref.angle === "close_up") ??
              creator.references.find((ref) => ref.kind === "sheet") ??
              creator.references.find((ref) => ref.isAnchor) ??
              creator.references[0];
            const sheetCount = creator.references.filter(
              (ref) =>
                ref.kind === "sheet" &&
                (DEFAULT_IDENTITY_ANGLES as readonly string[]).includes(ref.angle ?? ""),
            ).length;
            const ready = sheetCount >= DEFAULT_IDENTITY_ANGLES.length;

            return (
              <div key={creator.id} className="group relative">
                <Link
                  href={`/creators/${creator.id}`}
                  className="card-interactive block overflow-hidden"
                >
                  <div className="card-media aspect-[4/5]">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sized(publicUrlFor(cover.localPath), 320) || (cover.remoteUrl ?? "")}
                        alt={creator.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      /* A monogram rather than a blank 4:5 rectangle. An empty
                         card that size reads as a failed image load, which is
                         exactly the wrong impression for a creator whose seed
                         portrait is simply still rendering. */
                      <div className="grid h-full place-items-center bg-raised">
                        <div className="text-center">
                          <span className="block text-3xl font-semibold tracking-[-0.03em] text-faint">
                            {creator.name
                              .split(/\s+/)
                              .slice(0, 2)
                              .map((word) => word[0]?.toUpperCase() ?? "")
                              .join("")}
                          </span>
                          <span className="mt-1.5 block text-[11px] text-faint">
                            no reference yet
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2.5 p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="truncate font-medium tracking-[-0.01em]">{creator.name}</h2>
                      {creator.category ? (
                        <span className="shrink-0 text-[11px] text-faint">{creator.category}</span>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted">
                      {creator.identity.canonical}
                    </p>
                    {/* One honest status line instead of a row of angle chips.
                        The chips listed what existed; what an operator needs to
                        know is whether this creator can be cast yet. */}
                    <div className="flex items-center gap-2 pt-0.5 text-[11px]">
                      <span className={ready ? "dot dot-ok" : "dot dot-warn"} aria-hidden />
                      <span className={ready ? "text-muted" : "text-muted"}>
                        {ready
                          ? "Ready to cast"
                          : `Identity sheet ${sheetCount}/${DEFAULT_IDENTITY_ANGLES.length}`}
                      </span>
                      <span className="ml-auto max-w-[45%] truncate font-mono text-faint">
                        {creator.voice.label}
                      </span>
                    </div>
                  </div>
                </Link>
                {/* Outside the link, above it, revealed on hover. */}
                <div className="absolute right-2.5 top-2.5">
                  <DeleteButton
                    endpoint={`/api/creators/${creator.id}`}
                    label={`Delete ${creator.name}`}
                    confirmText={confirmDeleteCreator(
                      creator.name,
                      projectCount.get(creator.id) ?? 0,
                    )}
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

/**
 * What deleting a creator actually costs, spelled out.
 *
 * The database cascades from creators to projects, so this is never just "one
 * creator" — it takes their storyboards, scripts and every render with them.
 */
export function confirmDeleteCreator(name: string, projects: number): string {
  if (projects === 0) return `Delete ${name}? This cannot be undone.`;
  return (
    `Delete ${name}?\n\nThis also deletes ${projects} project${projects === 1 ? "" : "s"} ` +
    `made with them, including every storyboard, script and render. This cannot be undone.`
  );
}
