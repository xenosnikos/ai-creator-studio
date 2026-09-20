import Link from "next/link";

import { EXAMPLE_PROMPTS } from "@/lib/examples";
import { creators, projects } from "@/lib/repo";
import { publicUrlFor } from "@/lib/storage";
import { DEFAULT_IDENTITY_ANGLES } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const allCreators = creators.list();
  const allProjects = projects.list();
  const ready = allCreators.filter((creator) =>
    creator.references.some((ref) => ref.kind === "sheet"),
  );

  return (
    <div className="space-y-10">
      {/* --- the pitch ---------------------------------------------------- */}
      <section className="relative overflow-hidden rounded-[var(--radius-xl)] border border-edge bg-panel p-8 sm:p-10">
        {/* A wash behind the headline rather than a flat panel. Sits under the
            content and never gets in front of the text. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full bg-accent/[0.07] blur-3xl"
        />
        <div className="relative max-w-3xl">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-edge bg-raised px-3 py-1 text-[11px] text-muted">
            <span className="dot dot-ok" aria-hidden />
            Proof of concept
          </p>
          <h1 className="text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[2.125rem]">
            Generate social content with a creator who stays the same person.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted sm:text-[0.9375rem]">
            Build a creator once and their reference photos become a locked identity
            description, an angle sheet and a fixed voice. Every image afterwards is rendered
            image-to-image against that kit, and every clip is animated from an already-locked
            keyframe — so the same face survives front, side, rear, close-up and full-body
            shots. Storyboards are stored without the creator in them, which makes swapping one
            for another a substitution rather than a rewrite.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/creators/new" className="btn btn-primary btn-lg">
              Create a creator
            </Link>
            <Link href="/projects/new" className="btn btn-lg">
              Start a project
            </Link>
          </div>
        </div>
      </section>

      {/* --- where things stand ------------------------------------------- */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Creators" value={allCreators.length} href="/creators" />
        <Stat
          label="Identity kits built"
          value={ready.length}
          href="/creators"
          hint={`${DEFAULT_IDENTITY_ANGLES.length} core angles each`}
        />
        <Stat label="Projects" value={allProjects.length} href="/projects" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {/* --- recent creators, with faces --------------------------------- */}
        <div className="panel p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="section-title">Recent creators</h2>
            {allCreators.length > 0 ? (
              <Link href="/creators" className="text-[11px] text-muted hover:text-slate-200">
                All {allCreators.length} →
              </Link>
            ) : null}
          </div>
          {allCreators.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">
              None yet.{" "}
              <Link href="/creators/new" className="text-accent hover:underline">
                Create one
              </Link>{" "}
              or run <span className="font-mono text-slate-300">npm run seed</span> for the
              samples.
            </p>
          ) : (
            <ul className="space-y-1">
              {allCreators.slice(0, 5).map((creator) => {
                const face =
                  creator.references.find(
                    (ref) => ref.kind === "sheet" && ref.angle === "close_up",
                  ) ?? creator.references[0];
                return (
                  <li key={creator.id}>
                    <Link
                      href={`/creators/${creator.id}`}
                      className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition hover:border-edge hover:bg-ink"
                    >
                      <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-raised">
                        {face ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={publicUrlFor(face.localPath) ?? face.remoteUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{creator.name}</span>
                        <span className="block truncate text-[11px] text-faint">
                          {creator.category || "Uncategorised"}
                        </span>
                      </span>
                      <span className="chip shrink-0">
                        {creator.references.length} ref
                        {creator.references.length === 1 ? "" : "s"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* --- recent projects --------------------------------------------- */}
        <div className="panel p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="section-title">Recent projects</h2>
            {allProjects.length > 0 ? (
              <Link href="/projects" className="text-[11px] text-muted hover:text-slate-200">
                All {allProjects.length} →
              </Link>
            ) : null}
          </div>
          {allProjects.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">
              None yet.{" "}
              <Link href="/projects/new" className="text-accent hover:underline">
                Write a brief
              </Link>{" "}
              and it becomes a storyboard.
            </p>
          ) : (
            <ul className="space-y-1">
              {allProjects.slice(0, 5).map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition hover:border-edge hover:bg-ink"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{project.title}</span>
                      <span className="block truncate text-[11px] text-faint">
                        {project.prompt}
                      </span>
                    </span>
                    <span className="chip shrink-0 capitalize">{project.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* --- something to try --------------------------------------------- */}
      <section>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="section-title">Example briefs</h2>
          <span className="text-[11px] text-faint">Paste one into a new project</span>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {EXAMPLE_PROMPTS.map((example) => (
            <li key={example.prompt}>
              <Link
                href={`/projects/new?prompt=${encodeURIComponent(example.prompt)}`}
                className="card-interactive block h-full p-4"
              >
                <p className="text-sm leading-relaxed text-slate-200">{example.prompt}</p>
                <p className="mt-2.5 text-[11px] text-faint">
                  {example.category} · {example.duration}s
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: number;
  href: string;
  hint?: string;
}) {
  return (
    <Link href={href} className="card-interactive p-5">
      <p className="text-[11px] uppercase tracking-[0.06em] text-muted">{label}</p>
      <p className="mt-1.5 text-[2rem] font-semibold leading-none tracking-[-0.03em]">{value}</p>
      {hint ? <p className="mt-2 text-[11px] text-faint">{hint}</p> : null}
    </Link>
  );
}
