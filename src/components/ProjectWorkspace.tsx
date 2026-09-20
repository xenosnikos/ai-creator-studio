"use client";

import { sized } from "@/lib/asset-url";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { SceneCard } from "@/components/SceneCard";
import { SequencePlayer } from "@/components/SequencePlayer";
import { api } from "@/lib/client";
import type { ProjectView, SceneView } from "@/lib/views";
import { VIDEO_LABELS, type VideoStyle } from "@/lib/video-style";

type Stage = "image" | "voice" | "video";

/**
 * The project workspace: brief -> storyboard -> transcript -> voice -> images
 * -> video -> export, plus the character-swap panel.
 */
export function ProjectWorkspace({
  initial,
  creators,
}: {
  initial: ProjectView;
  creators: Array<{ id: string; name: string; referenceCount: number }>;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [swapCreatorId, setSwapCreatorId] = useState(
    creators.find((c) => c.id !== initial.project.creatorId)?.id ?? "",
  );
  const [swapMode, setSwapMode] = useState<"compare" | "replace">("compare");

  const projectId = view.project.id;

  const refresh = useCallback(async () => {
    try {
      const data = await api<ProjectView>(`/api/projects/${projectId}`);
      setView(data);
    } catch {
      // A failed refresh just means the next poll picks it up.
    }
  }, [projectId]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Queue renders and report what actually happened.
   *
   * The API skips anything already in flight rather than billing for a
   * duplicate, so a click can legitimately do nothing — and silence there
   * looks identical to a broken button.
   */
  const queue = (label: string, body: Record<string, unknown>) =>
    run(label, async () => {
      const result = await api<{ jobs: unknown[]; skipped: number }>(
        `/api/projects/${projectId}/render`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setNotice(
        result.jobs.length === 0
          ? "Already rendering — nothing new to queue."
          : result.skipped > 0
            ? `Queued ${result.jobs.length}; skipped ${result.skipped} already in flight.`
            : null,
      );
    });

  const renderScene = (sceneId: string, stages: Stage[]) =>
    queue(`scene-${sceneId}`, { stages, sceneIds: [sceneId] });

  const approveStoryboard = () =>
    run("approve-storyboard", () =>
      api(`/api/projects/${projectId}/approve-storyboard`, { method: "POST" }),
    );

  const approveStill = (sceneId: string) =>
    run(`scene-${sceneId}`, () =>
      api(`/api/scenes/${sceneId}/approve-still`, { method: "POST" }),
    );

  const hasScenes = view.scenes.length > 0;
  /**
   * A photo set has no narration and nothing to animate, so the voice and clip
   * stages are not "not done yet" — they do not apply. Offering buttons that
   * queue work with no output is how an operator learns not to trust the ones
   * that do.
   */
  const isPhoto = view.project.settings.kind === "photo";

  /**
   * Poll while anything is in flight.
   *
   * The job feed used to drive this as a side effect of rendering itself, so
   * removing the feed also removed the page's only way of noticing that a
   * render had finished. Polling belongs to the page, not to one component
   * that happened to be on it.
   */
  /**
   * Any job in flight, not just a scene's.
   *
   * This used to look only at scene stages, which meant it could not see the
   * one job that runs before any scene exists: the storyboard. So a project
   * created from the form sat on "No storyboard yet" indefinitely — the job
   * finished in under a minute, the page never asked again, and the only way
   * out was a manual reload. Reported as twenty minutes of nothing happening,
   * and it was the page that was idle, not the pipeline.
   *
   * Reading the job feed covers the storyboard, the final cut, and anything
   * else that is not attached to a scene.
   */
  const working =
    view.jobs.some((job) => job.status === "queued" || job.status === "running") ||
    view.scenes.some((scene) =>
      (["image", "voice", "video"] as const).some(
        (stage) => scene.status[stage].state === "running" || scene.status[stage].state === "queued",
      ),
    );
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [working, refresh]);
  /** The newest storyboard attempt, so a failure can be shown rather than hidden. */
  const storyboardJob = [...view.jobs].reverse().find((job) => job.type === "storyboard");
  const rendered = view.scenes.filter((scene) => scene.image).length;
  const storyboardApproved = Boolean(view.project.storyboardApprovedAt);
  const approvedStills = view.scenes.filter((scene) => scene.stillApproved).length;
  const missingStillIds = view.scenes
    .filter(
      (scene) =>
        scene.status.image.state !== "done" &&
        scene.status.image.state !== "running" &&
        scene.status.image.state !== "queued",
    )
    .map((scene) => scene.id);
  const productionSceneIds = view.scenes
    .filter(
      (scene) =>
        scene.status.video.state !== "done" &&
        scene.status.video.state !== "running" &&
        scene.status.video.state !== "queued",
    )
    .map((scene) => scene.id);

  const failedScenes = view.scenes.filter((scene) =>
    (["image", "voice", "video"] as const).some((s) => scene.status[s].state === "failed"),
  );

  return (
    <div className="space-y-6">
      {/* --- header ------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/projects" className="text-xs text-muted hover:text-slate-300">
            ← Projects
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {view.project.title}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{view.project.prompt}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="chip">
              {view.creator ? (
                <Link href={`/creators/${view.creator.id}`} className="hover:text-slate-200">
                  {view.creator.name}
                </Link>
              ) : (
                "deleted creator"
              )}
            </span>
            <span className="chip">
              {isPhoto
                ? `${view.scenes.length || view.project.settings.photoCount} images`
                : `${view.project.settings.targetDurationSeconds}s`}
            </span>
            <span className="chip">{view.project.settings.aspectRatio}</span>
            <span className="chip">{view.project.settings.videoResolution}</span>
            <span className="chip">
              {view.project.settings.look === "cinematic" ? "cinematic" : "phone look"}
            </span>
            {/* The direction chosen for this piece. Shown because a setting you
                cannot see having been applied is a setting you cannot trust. */}
            {videoStyleChips(view.project.settings.videoStyle).map((chip) => (
              <span key={chip} className="chip">
                {chip}
              </span>
            ))}
            {view.project.wardrobeRefs.length > 0 ? (
              <span className="chip">outfit from photo</span>
            ) : null}
            {view.project.backgroundRefs.length > 0 ? (
              <span className="chip">place from photo</span>
            ) : null}
            <span className="chip">
              {rendered}/{view.scenes.length} {isPhoto ? "rendered" : "keyframes"}
            </span>
            <span className="chip">
              {storyboardApproved ? "script approved" : "awaiting script approval"}
            </span>
            {!isPhoto ? <span className="chip">{approvedStills}/{view.scenes.length} stills approved</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run("storyboard", () =>
                api(`/api/projects/${projectId}/storyboard`, { method: "POST" }),
              )
            }
            className="btn"
          >
            {isPhoto
              ? hasScenes
                ? "Re-plan the shots"
                : "Plan the shots"
              : hasScenes
                ? "Regenerate storyboard"
                : "Generate storyboard"}
          </button>
          <a href={`/api/projects/${projectId}/export`} className="btn">
            Export bundle
          </a>
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              if (!confirm(`Delete "${view.project.title}" and everything rendered for it?`)) {
                return;
              }
              await run("delete", () =>
                api(`/api/projects/${projectId}`, { method: "DELETE" }),
              );
              router.push("/projects");
            }}
            className="btn btn-ghost btn-danger"
          >
            Delete
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-muted">
          {notice}
        </p>
      ) : null}

      {!hasScenes ? (
        /**
         * Three different situations shared one message: nothing started yet,
         * something running, and something that failed. A storyboard that
         * errored looked exactly like one that had never been asked for, which
         * is how a failed job goes unnoticed until someone asks why the page
         * has not changed in twenty minutes.
         */
        <div className="panel p-10 text-center text-sm">
          {storyboardJob?.status === "failed" ? (
            <>
              <p className="font-medium text-[var(--danger)]">Generating the storyboard failed.</p>
              <p className="mt-2 text-muted">{storyboardJob.error ?? "No reason was recorded."}</p>
              <p className="mt-2 text-muted">
                Fix the cause and press Generate storyboard to try again.
              </p>
            </>
          ) : working ? (
            <p className="text-muted">
              Writing the storyboard — the shot list, dialogue and transcript. This takes under a
              minute.
            </p>
          ) : (
            <p className="text-muted">
              No storyboard yet. Generating one produces the shot list, dialogue and transcript.
            </p>
          )}
        </div>
      ) : (
        <>
          <ApprovalWorkflow
            isPhoto={isPhoto}
            transcript={view.project.transcript}
            scenes={view.scenes}
            storyboardApproved={storyboardApproved}
            busy={busy !== null}
            onApproveStoryboard={approveStoryboard}
            onGenerateStills={() =>
              queue("render-image", { stages: ["image"], sceneIds: missingStillIds })
            }
            onGenerateProduction={() =>
              queue("render-voice-video", {
                stages: ["voice", "video"],
                sceneIds: productionSceneIds,
              })
            }
          />

          <ResultPanel
            isPhoto={isPhoto}
            finalCut={view.finalCut}
            scenes={view.scenes}
            aspectRatio={view.project.settings.aspectRatio}
            failedCount={failedScenes.length}
            busy={busy === "rebuild-cut"}
            onRebuild={() => queue("rebuild-cut", { stages: ["cut"] })}
          />

          {/* --- everything else, folded away ------------------------------ */}
          <details className="group/d" open>
            <summary className="inline-flex cursor-pointer select-none items-center gap-2 py-2 text-xs text-muted transition hover:text-slate-200">
              <span className="inline-block transition group-open/d:rotate-90">›</span>
              Review and edit every scene
            </summary>
            <div className="mt-3 space-y-6">
          <section className="space-y-3">
            <h2 className="section-title">
              Storyboard
            </h2>
            {view.scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                // Only this scene's own queueing call disables its buttons.
                // A global flag meant queueing one scene greyed out all twelve.
                busy={busy === `scene-${scene.id}`}
                onChanged={refresh}
                onRender={renderScene}
                onApprove={approveStill}
                storyboardApproved={storyboardApproved}
                requiresStillApproval={!isPhoto}
              />
            ))}
          </section>

          {/* --- character swap -------------------------------------------- */}
          <section className="panel p-5">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">
              Character swap
            </h2>
            <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
              The storyboard, shot list, dialogue, environments and camera work stay exactly
              as they are — only the creator changes. That works because scenes are stored
              with the subject as a placeholder, so swapping is a substitution in the prompt
              compiler rather than a regeneration.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <label className="label" htmlFor="swap-creator">
                  Swap to
                </label>
                <select
                  id="swap-creator"
                  className="field"
                  value={swapCreatorId}
                  onChange={(event) => setSwapCreatorId(event.target.value)}
                >
                  <option value="">Select a creator…</option>
                  {creators
                    .filter((creator) => creator.id !== view.project.creatorId)
                    .map((creator) => (
                      <option key={creator.id} value={creator.id}>
                        {creator.name}
                        {creator.referenceCount === 0 ? " (no references)" : ""}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Mode</label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSwapMode("compare")}
                    className={`btn btn-sm ${swapMode === "compare" ? "btn-primary" : ""}`}
                    title="Render a parallel set so both versions can be compared"
                  >
                    Compare
                  </button>
                  <button
                    type="button"
                    onClick={() => setSwapMode("replace")}
                    className={`btn btn-sm ${swapMode === "replace" ? "btn-primary" : ""}`}
                    title="Re-point the project at the new creator"
                  >
                    Replace
                  </button>
                </div>
              </div>
              <button
                type="button"
                disabled={busy !== null || !swapCreatorId || !storyboardApproved}
                onClick={() =>
                  run("swap", () =>
                    api(`/api/projects/${projectId}/swap`, {
                      method: "POST",
                      body: JSON.stringify({
                        creatorId: swapCreatorId,
                        mode: swapMode,
                        stages: ["image"],
                      }),
                    }),
                  )
                }
                className="btn btn-primary"
              >
                {busy === "swap" ? "Queueing…" : "Swap & render preview stills"}
              </button>
            </div>

            {view.swapCreators.length > 0 ? (
              <div className="mt-6 space-y-5">
                {view.swapCreators.map(({ creator, scenes }) => (
                  <div key={creator.id}>
                    <p className="mb-2 text-xs font-medium text-slate-300">
                      Same scenes rendered as{" "}
                      <Link href={`/creators/${creator.id}`} className="hover:underline">
                        {creator.name}
                      </Link>
                    </p>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
                      {scenes.map((scene) => (
                        <div key={scene.id} className="space-y-1">
                          <div className="aspect-[9/16] overflow-hidden rounded-lg border border-edge bg-ink">
                            {scene.image?.url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sized(scene.image.url, 640)}
                                alt={scene.title}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="grid h-full place-items-center text-[10px] text-muted">
                                —
                              </div>
                            )}
                          </div>
                          <p className="text-center text-[10px] text-muted">{scene.index + 1}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * The video's direction, as short chips.
 *
 * Only the picks that change what you SEE — format, place, time and pacing.
 * Listing all eight would push the real status (scene counts, render progress)
 * off the row on a narrow screen.
 */
function videoStyleChips(style: VideoStyle | undefined): string[] {
  if (!style) return [];
  return [
    style.format ? VIDEO_LABELS.format[style.format].toLowerCase() : "",
    style.setting ? VIDEO_LABELS.setting[style.setting].toLowerCase() : "",
    style.timeOfDay ? VIDEO_LABELS.timeOfDay[style.timeOfDay].toLowerCase() : "",
    style.pacing ? VIDEO_LABELS.pacing[style.pacing].toLowerCase() : "",
  ].filter(Boolean);
}

/**
 * The two explicit spend gates: approve words/shots before stills, then approve
 * each exact still before clips. The API enforces the same rules server-side.
 */
function ApprovalWorkflow({
  isPhoto,
  transcript,
  scenes,
  storyboardApproved,
  busy,
  onApproveStoryboard,
  onGenerateStills,
  onGenerateProduction,
}: {
  isPhoto: boolean;
  transcript: string;
  scenes: SceneView[];
  storyboardApproved: boolean;
  busy: boolean;
  onApproveStoryboard: () => void;
  onGenerateStills: () => void;
  onGenerateProduction: () => void;
}) {
  const stillsDone = scenes.filter((scene) => scene.status.image.state === "done").length;
  const stillsWorking = scenes.some(
    (scene) => scene.status.image.state === "running" || scene.status.image.state === "queued",
  );
  const approved = scenes.filter((scene) => scene.stillApproved).length;
  const clipsDone = scenes.filter((scene) => scene.status.video.state === "done").length;
  const clipsWorking = scenes.some(
    (scene) => scene.status.video.state === "running" || scene.status.video.state === "queued",
  );
  const allStillsDone = stillsDone === scenes.length;
  const allStillsApproved = approved === scenes.length && scenes.length > 0;

  return (
    <section className="panel space-y-4 p-5">
      <div>
        <h2 className="section-title">Approval workflow</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Nothing advances automatically. Edit the words and shot direction below; each approval
          unlocks only the next stage.
        </p>
      </div>

      {!isPhoto ? (
        <div className="rounded-lg border border-edge bg-ink p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-slate-300">Complete script</p>
            <span className="text-[10px] text-muted">Edit each scene’s words below</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
            {transcript.trim() || "Silent — no spoken script."}
          </p>
        </div>
      ) : null}

      <div className={`grid gap-2 ${isPhoto ? "sm:grid-cols-2" : "sm:grid-cols-4"}`}>
        <ApprovalStep
          number={1}
          title={isPhoto ? "Confirm shot list" : "Confirm script + shots"}
          detail={
            storyboardApproved
              ? "Approved. Any scene edit automatically reopens this step."
              : "Review every scene below and correct the dialogue or direction first."
          }
          complete={storyboardApproved}
        >
          {!storyboardApproved ? (
            <button
              type="button"
              disabled={busy}
              onClick={onApproveStoryboard}
              className="btn btn-sm btn-primary w-full"
            >
              Approve plan
            </button>
          ) : null}
        </ApprovalStep>

        <ApprovalStep
          number={2}
          title="Generate preview stills"
          detail={`${stillsDone}/${scenes.length} stills ready. Scene 1 locks the haircut and complete outfit for every later still. No voice or video is generated here.`}
          complete={allStillsDone}
        >
          {!allStillsDone ? (
            <button
              type="button"
              disabled={busy || !storyboardApproved || stillsWorking}
              onClick={onGenerateStills}
              className="btn btn-sm w-full"
            >
              {stillsWorking ? "Generating…" : "Generate missing stills"}
            </button>
          ) : null}
        </ApprovalStep>

        {!isPhoto ? (
          <ApprovalStep
            number={3}
            title="Approve every still"
            detail={`${approved}/${scenes.length} approved. Re-rendering a still removes its approval.`}
            complete={allStillsApproved}
          >
            <p className="text-[10px] leading-relaxed text-muted">
              Use “Approve still” on each scene only after checking face, skin tone, hair and outfit.
            </p>
          </ApprovalStep>
        ) : null}

        {!isPhoto ? (
          <ApprovalStep
            number={4}
            title="Generate video"
            detail={`${clipsDone}/${scenes.length} current clips ready. This is the expensive stage.`}
            complete={clipsDone === scenes.length}
          >
            {clipsDone < scenes.length ? (
              <button
                type="button"
                disabled={busy || clipsWorking || !storyboardApproved || !allStillsApproved}
                onClick={onGenerateProduction}
                className="btn btn-sm btn-primary w-full"
              >
                {clipsWorking ? "Generating…" : "Generate approved videos"}
              </button>
            ) : null}
          </ApprovalStep>
        ) : null}
      </div>
    </section>
  );
}

function ApprovalStep({
  number,
  title,
  detail,
  complete,
  children,
}: {
  number: number;
  title: string;
  detail: string;
  complete: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-h-36 flex-col rounded-lg border p-3 ${
        complete ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-edge bg-raised"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
            complete ? "bg-emerald-400/20 text-emerald-200" : "bg-ink text-muted"
          }`}
        >
          {complete ? "✓" : number}
        </span>
        <p className="text-xs font-medium text-slate-200">{title}</p>
      </div>
      <p className="mb-3 mt-2 flex-1 text-[11px] leading-relaxed text-muted">{detail}</p>
      {children}
    </div>
  );
}

/**
 * What the project produced, and nothing about how.
 *
 * This replaced a strip of per-stage buttons and a transcript editor. Those
 * exposed the pipeline — keyframes, voice, clips as separate things to drive —
 * when the operator had already commissioned all of it on the previous screen.
 * What belongs here is the finished piece, or an honest account of how far off
 * it is.
 */
function ResultPanel({
  isPhoto,
  finalCut,
  scenes,
  aspectRatio,
  failedCount,
  busy,
  onRebuild,
}: {
  isPhoto: boolean;
  finalCut: { url: string; bytes: number; audio: string | null } | null;
  scenes: SceneView[];
  aspectRatio: string;
  failedCount: number;
  busy: boolean;
  onRebuild: () => void;
}) {
  const done = scenes.filter((scene) =>
    isPhoto ? scene.status.image.state === "done" : scene.status.video.state === "done",
  );
  const complete = done.length === scenes.length && scenes.length > 0;
  const working = scenes.some((scene) =>
    (["image", "voice", "video"] as const).some(
      (s) => scene.status[s].state === "running" || scene.status[s].state === "queued",
    ),
  );

  const clips = scenes
    .filter((scene) => scene.status.video.state === "done" && scene.video?.url)
    .map((scene) => ({ id: scene.id, url: scene.video!.url!, title: scene.title }));

  if (complete && !isPhoto) {
    return (
      <section className="panel p-5">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="section-title">Your video</h2>
          <span className="text-[11px] text-faint">
            {finalCut
              ? `${clips.length} shots, joined`
              : `${clips.length} shot${clips.length === 1 ? "" : "s"}, played in order`}
          </span>
        </div>
        {/* One file when it exists, the shot sequence otherwise. Joining needs
            ffmpeg; without it every shot still rendered and still plays. */}
        {finalCut ? (
          <div className="space-y-3">
            <div
              className="relative mx-auto overflow-hidden rounded-[var(--radius-lg)] border border-edge bg-black"
              style={{ aspectRatio: aspectRatio.replace(":", " / "), maxHeight: "70vh" }}
            >
              <video src={finalCut.url} controls playsInline className="h-full w-full object-contain" />
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
                <a href={finalCut.url} download className="btn btn-sm">
                  Download the video
                </a>
                {/* Joining, room sound and music are all ffmpeg over shots that
                    are already paid for, so this costs nothing and is the way
                    back from a bed that failed on a key you have since fixed. */}
                <button type="button" className="btn btn-sm btn-ghost" onClick={onRebuild} disabled={busy}>
                  {busy ? "Rebuilding…" : "Rebuild (free)"}
                </button>
              </div>
              {finalCut.audio ? (
                <p className="text-[11px] text-faint">{finalCut.audio}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <SequencePlayer clips={clips} aspectRatio={aspectRatio} />
        )}
      </section>
    );
  }

  if (complete && isPhoto) {
    return (
      <section className="panel p-5">
        <h2 className="section-title mb-4">Your images</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {done.map((scene) => (
            <a
              key={scene.id}
              href={scene.image!.url ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="card-media block overflow-hidden rounded-[var(--radius)] border border-edge"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sized(scene.image!.url, 1080)} alt={scene.title} className="w-full" />
            </a>
          ))}
        </div>
      </section>
    );
  }

  /**
   * Progress across every stage, not just the last one.
   *
   * Counting finished clips alone left the bar at 0% while nine jobs ran for
   * several minutes, which is indistinguishable from a hang. The shots are
   * still the unit reported in words; the bar tracks the work underneath.
   */
  const steps = isPhoto ? (["image"] as const) : (["image", "voice", "video"] as const);
  const total = scenes.length * steps.length;
  const finished = scenes.reduce(
    (sum, scene) =>
      sum + steps.filter((s) => scene.status[s].state === "done").length,
    0,
  );
  const pct = total ? Math.round((finished / total) * 100) : 0;
  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {failedCount > 0
              ? `${failedCount} shot${failedCount === 1 ? "" : "s"} failed`
              : working
                ? isPhoto
                  ? "Rendering your images…"
                  : "Rendering your video…"
                : "Ready to render"}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {failedCount > 0
              ? "The rest are fine. Retry just the ones that failed."
              : working
                ? `${done.length} of ${scenes.length} ${isPhoto ? "images" : "shots"} finished. This takes a few minutes — you can leave the page.`
                : `${scenes.length} ${isPhoto ? "images" : "shots"} planned.`}
          </p>
        </div>
        <div className="shrink-0">
          {failedCount > 0 ? (
            <span className="text-[11px] text-red-200">Retry from the affected scene below</span>
          ) : working ? (
            <span className="text-2xl font-semibold tabular-nums text-muted">{pct}%</span>
          ) : (
            <span className="text-[11px] text-muted">Use the approval steps above</span>
          )}
        </div>
      </div>
      {/* A bar rather than a spinner: this runs for minutes, and a spinner that
          long is indistinguishable from a hang. */}
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-ink">
        <div
          className="h-full rounded-full bg-accent transition-all duration-700"
          style={{ width: `${Math.max(pct, working ? 4 : 0)}%` }}
        />
      </div>
    </section>
  );
}
