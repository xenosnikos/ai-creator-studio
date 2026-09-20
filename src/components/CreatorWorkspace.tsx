"use client";

import { sized } from "@/lib/asset-url";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { JobFeed } from "@/components/JobFeed";
import { LookPicker } from "@/components/LookPicker";
import { api, fileToDataUrl, videoToFrames } from "@/lib/client";
import {
  DEFAULT_IDENTITY_ANGLES,
  IDENTITY_ANGLES,
  IDENTITY_ANGLE_LABELS,
  type IdentityBlock,
} from "@/lib/types";
import type { CreatorLook } from "@/lib/look";
import type { CreatorView } from "@/lib/views";

/**
 * Creator detail.
 *
 * The identity sheet grid is the consistency evidence: the same person rendered
 * across six canonical angles from the same anchors. It doubles as the anchor
 * pool — a rear shot in a storyboard pulls the sheet's rear frame as its
 * reference rather than a frontal portrait.
 */
export function CreatorWorkspace({ initial }: { initial: CreatorView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [identity, setIdentity] = useState<IdentityBlock>(initial.creator.identity);
  const [notes, setNotes] = useState(initial.creator.appearanceNotes ?? "");
  const [look, setLook] = useState<CreatorLook>(initial.creator.look ?? {});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Read inside `refresh` without making it a dependency: `refresh` is passed
  // to JobFeed as `onSettled`, and JobFeed restarts its polling whenever that
  // identity changes. Tying it to `dirty` restarted the poll every time the
  // operator started or stopped editing.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const creator = view.creator;

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ creator: CreatorView["creator"]; jobs: CreatorView["jobs"] }>(
        `/api/creators/${creator.id}`,
      );
      // Re-derive the view from the API's creator payload.
      setView((current) => ({
        ...current,
        creator: data.creator,
        jobs: data.jobs ?? current.jobs,
        seedRefs: data.creator.references
          .filter((ref) => ref.kind === "seed")
          .map((ref) => ({
            id: ref.id,
            url: assetUrl(ref.localPath, ref.remoteUrl),
            isAnchor: ref.isAnchor,
          })),
        sheet: data.creator.references
          .filter((ref) => ref.kind === "sheet")
          .map((ref) => ({
            id: ref.id,
            angle: ref.angle,
            url: assetUrl(ref.localPath, ref.remoteUrl),
          })),
      }));
      if (!dirtyRef.current) setIdentity(data.creator.identity);
    } catch {
      // Ignore refresh failures; the next poll will retry.
    }
  }, [creator.id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function uploadRefs(fileList: FileList | null) {
    if (!fileList?.length) return;
    // Same as creator intake: a video is reduced to stills in the browser
    // rather than uploaded, because stills are all the pipeline consumes.
    const collected = await Promise.all(
      Array.from(fileList)
        .slice(0, 10)
        .map((file) =>
          file.type.startsWith("video/") ? videoToFrames(file, 4) : fileToDataUrl(file),
        ),
    );
    const images = collected.flat().slice(0, 10);
    await run("upload", () =>
      api(`/api/creators/${creator.id}/references`, {
        method: "POST",
        body: JSON.stringify({ images, isAnchor: true }),
      }),
    );
  }

  const sheetByAngle = new Map(view.sheet.map((shot) => [shot.angle, shot]));
  const [showAllAngles, setShowAllAngles] = useState(false);
  // The two core angles, plus any extra that has actually been generated —
  // an existing frame should never disappear behind a disclosure.
  const visibleAngles = showAllAngles
    ? [...IDENTITY_ANGLES]
    : IDENTITY_ANGLES.filter(
        (angle) =>
          (DEFAULT_IDENTITY_ANGLES as readonly string[]).includes(angle) ||
          sheetByAngle.has(angle),
      );

  /**
   * Whether the two core frames are on their way.
   *
   * They are queued automatically when the creator is made, so for the first
   * minute or two of a creator's life the tiles are empty *because work is in
   * flight* — and an empty tile offering a "Generate" button in that window
   * invites a click that queues a second, billable copy of a render already
   * running.
   *
   * The seed portrait counts too: a synthesized creator's sheet job waits for
   * it, so the tiles are legitimately empty for that whole stretch as well.
   */
  const sheetRunning = view.jobs.some(
    (job) =>
      (job.type === "identity_sheet" || job.type === "creator_bootstrap") &&
      (job.status === "queued" || job.status === "running"),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/creators" className="text-xs text-muted hover:text-slate-300">
            ← Creator library
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{creator.name}</h1>
          <p className="text-sm text-muted">
            {creator.category || "Uncategorised"} · voice{" "}
            <span className="font-mono text-slate-300">{creator.voice.label}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run("sheet", () =>
                api(`/api/creators/${creator.id}/identity-sheet`, {
                  method: "POST",
                  body: JSON.stringify({ replace: true }),
                }),
              )
            }
            className="btn btn-primary"
          >
            {busy === "sheet" ? "Queueing…" : "Rebuild identity sheet"}
          </button>
          <Link href={`/projects/new?creator=${creator.id}`} className="btn">
            New project
          </Link>
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              if (
                !confirm(
                  `Delete ${creator.name}?\n\n` +
                    (view.projectCount > 0
                      ? `This also deletes ${view.projectCount} project${view.projectCount === 1 ? "" : "s"} ` +
                        `made with them, including every storyboard, script and render. `
                      : `They have no projects yet. `) +
                    `This cannot be undone.`,
                )
              ) {
                return;
              }
              await run("delete", () => api(`/api/creators/${creator.id}`, { method: "DELETE" }));
              router.push("/creators");
            }}
            className="btn btn-ghost btn-danger"
          >
            Delete
          </button>
        </div>
      </div>

      <JobFeed creatorId={creator.id} onSettled={refresh} />

      {error ? (
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {/* --- identity sheet ------------------------------------------------ */}
      <section className="panel p-5">
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <h2 className="section-title">
            Identity sheet
          </h2>
          <span className="text-[11px] text-muted">
            {view.sheet.length} of {DEFAULT_IDENTITY_ANGLES.length} core angles
          </span>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-muted">
          A close-up and a full body are rendered automatically — between them they carry
          the face, the proportions and the wardrobe that every later shot is matched
          against. Extra angles are there if a storyboard needs one; generate them
          individually rather than waiting on all six up front.
        </p>
        {/* Fixed-width tiles rather than a stretching grid: with only the two
            core angles generated, a four-column grid blew each frame up to a
            300px black rectangle and the section read as broken. */}
        <div className="flex flex-wrap gap-3 [&>*]:w-[150px]">
          {/*
            Only the two core angles are generated automatically. The rest sit
            behind a disclosure rather than four permanent "not generated"
            tiles, which read as a broken page rather than an offer.
          */}
          {visibleAngles.map((angle) => {
            const shot = sheetByAngle.get(angle);
            return (
              <div key={angle} className="space-y-1.5">
                <div className="aspect-[3/4] overflow-hidden rounded-lg border border-edge bg-ink">
                  {shot?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sized(shot.url, 640)}
                      alt={IDENTITY_ANGLE_LABELS[angle]}
                      className="h-full w-full object-cover"
                    />
                  ) : sheetRunning &&
                    (DEFAULT_IDENTITY_ANGLES as readonly string[]).includes(angle) ? (
                    <div className="grid h-full w-full place-items-center px-2 text-center text-[11px] text-muted">
                      generating…
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`angle-${angle}`, () =>
                          api(`/api/creators/${creator.id}/identity-sheet`, {
                            method: "POST",
                            body: JSON.stringify({ angles: [angle], replace: false }),
                          }),
                        )
                      }
                      className="grid h-full w-full place-items-center px-2 text-center text-[11px] text-muted transition-colors hover:bg-white/[0.03] hover:text-slate-300"
                    >
                      {busy === `angle-${angle}` ? "queueing…" : "Generate"}
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-1">
                  <p className="text-[11px] text-muted">{IDENTITY_ANGLE_LABELS[angle]}</p>
                  <button
                    type="button"
                    disabled={busy !== null}
                    title={`Regenerate ${IDENTITY_ANGLE_LABELS[angle]}`}
                    onClick={() =>
                      run(`angle-${angle}`, () =>
                        api(`/api/creators/${creator.id}/identity-sheet`, {
                          method: "POST",
                          body: JSON.stringify({ angles: [angle], replace: false }),
                        }),
                      )
                    }
                    className="text-[11px] text-muted hover:text-emerald-300"
                  >
                    ↻
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {visibleAngles.length < IDENTITY_ANGLES.length ? (
          <button
            type="button"
            onClick={() => setShowAllAngles(true)}
            className="btn btn-sm btn-ghost mt-3"
          >
            Show {IDENTITY_ANGLES.length - visibleAngles.length} more angles
          </button>
        ) : null}
      </section>

      {/* items-start so each panel keeps its own height — stretched to match,
          the shorter one grew a large empty tail. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* --- seed references -------------------------------------------- */}
        <section className="panel p-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">
            Seed references
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Ground truth for this creator. Anchored references are attached to every render;
            unanchor one to stop it influencing generations without deleting it.
          </p>

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {view.seedRefs.map((ref) => (
              <div key={ref.id} className="space-y-1">
                <div
                  className={`aspect-square overflow-hidden rounded-lg border-2 bg-ink ${
                    ref.isAnchor ? "border-emerald-400/60" : "border-edge"
                  }`}
                >
                  {ref.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sized(ref.url, 320)} alt="Reference" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-1 text-[10px]">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run("anchor", () =>
                        api(`/api/creators/${creator.id}/references/${ref.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ isAnchor: !ref.isAnchor }),
                        }),
                      )
                    }
                    className={ref.isAnchor ? "text-emerald-300" : "text-muted hover:text-slate-300"}
                  >
                    {ref.isAnchor ? "anchored" : "anchor"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run("delete-ref", () =>
                        api(`/api/creators/${creator.id}/references/${ref.id}`, {
                          method: "DELETE",
                        }),
                      )
                    }
                    className="text-muted hover:text-red-300"
                  >
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <label className="label mt-4" htmlFor="add-refs">
            Add references
          </label>
          <input
            id="add-refs"
            type="file"
            accept="image/*,video/*"
            multiple
            disabled={busy !== null}
            className="field file:mr-3 file:rounded file:border-0 file:bg-edge file:px-2 file:py-1 file:text-slate-200"
            onChange={(event) => void uploadRefs(event.target.files)}
          />
        </section>

        {/* --- identity block --------------------------------------------- */}
        <section className="panel p-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">
            Locked identity block
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Injected verbatim at the top of every image prompt. Editing it here is the
            supported way to correct drift — tighten a feature the model keeps getting wrong
            and every subsequent render picks it up.
          </p>

          {/* The brief the block was written from. Kept editable and re-runnable:
              when the description does not match what was asked for, rewriting it
              by hand is the slow fix and this is the fast one. */}
          <div className="mb-4 rounded-lg border border-edge bg-ink p-3">
            <p className="label">How this creator should look</p>
            <LookPicker value={look} onChange={setLook} />

            <label className="label mt-3 block" htmlFor="appearance-notes">
              Anything else
            </label>
            <textarea
              id="appearance-notes"
              className="field resize-y text-xs leading-relaxed"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Blonde, blue eyes, clear skin, striking and model-like…"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run("identity", async () => {
                    const result = await api<{ creator: CreatorView["creator"] }>(
                      `/api/creators/${creator.id}/identity`,
                      {
                        method: "POST",
                        body: JSON.stringify({ appearanceNotes: notes, look }),
                      },
                    );
                    setIdentity(result.creator.identity);
                    setDirty(false);
                  })
                }
                className="btn btn-sm btn-primary"
              >
                {busy === "identity" ? "Rewriting…" : "Rewrite description from this"}
              </button>
              <span className="text-[11px] text-muted">
                Replaces the fields below. Rebuild the identity sheet afterwards to see it.
              </span>
            </div>
          </div>

          <div className="space-y-3">
            <Field
              label="Canonical description"
              value={identity.canonical}
              rows={5}
              onChange={(canonical) => {
                setIdentity({ ...identity, canonical });
                setDirty(true);
              }}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Face"
                value={identity.face}
                rows={2}
                onChange={(face) => {
                  setIdentity({ ...identity, face });
                  setDirty(true);
                }}
              />
              <Field
                label="Hair"
                value={identity.hair}
                rows={2}
                onChange={(hair) => {
                  setIdentity({ ...identity, hair });
                  setDirty(true);
                }}
              />
              <Field
                label="Skin tone"
                value={identity.skinTone}
                rows={2}
                onChange={(skinTone) => {
                  setIdentity({ ...identity, skinTone });
                  setDirty(true);
                }}
              />
              <Field
                label="Build"
                value={identity.bodyType}
                rows={2}
                onChange={(bodyType) => {
                  setIdentity({ ...identity, bodyType });
                  setDirty(true);
                }}
              />
              <Field
                label="Distinguishing features"
                value={identity.distinguishingFeatures}
                rows={2}
                onChange={(distinguishingFeatures) => {
                  setIdentity({ ...identity, distinguishingFeatures });
                  setDirty(true);
                }}
              />
              <Field
                label="Default wardrobe"
                value={identity.wardrobe}
                rows={2}
                onChange={(wardrobe) => {
                  setIdentity({ ...identity, wardrobe });
                  setDirty(true);
                }}
              />
            </div>
            <Field
              label="Drift guards (negative)"
              value={identity.negative}
              rows={2}
              onChange={(negative) => {
                setIdentity({ ...identity, negative });
                setDirty(true);
              }}
            />

            {/*
              With nothing edited there is nothing to save, and this used to be
              a disabled button labelled "Saved" — which looks exactly like a
              save button that refuses to work, cursor and all. State that is
              not an action should not be shaped like one, so the settled case
              is a plain status line and the button only appears when pressing
              it would actually do something.
            */}
            {dirty || busy === "identity" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run("identity", async () => {
                    await api(`/api/creators/${creator.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ identity }),
                    });
                    setDirty(false);
                  })
                }
                className="btn btn-primary w-full"
              >
                {busy === "identity" ? "Saving…" : "Save identity block"}
              </button>
            ) : (
              <p className="help flex items-center justify-center gap-1.5 py-2 text-center">
                <span className="text-accent">✓</span>
                All changes saved. Edit any field above to enable saving again.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Mirror of the server-side `publicUrlFor`, kept tiny to avoid pulling node deps client-side. */
function assetUrl(localPath: string | null, fallback: string): string {
  if (!localPath) return fallback;
  return `/api/assets/${localPath.split("/").map(encodeURIComponent).join("/")}`;
}

function Field({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {/* `field` fixes a height, which silently clipped any value longer than
          `rows` — the canonical description and the drift guards both overflow
          routinely. Auto-grow instead so the whole value is always readable. */}
      <textarea
        className="field resize-y text-xs leading-relaxed"
        style={{ height: "auto", minHeight: `${rows * 1.6 + 1.2}rem` }}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
