"use client";

import { sized } from "@/lib/asset-url";
import { useEffect, useId, useState } from "react";

import { api } from "@/lib/client";
import { EXAMPLE_INSTRUCTIONS } from "@/lib/examples";
import {
  CAMERA_MOVES,
  IDENTITY_ANGLES,
  IDENTITY_ANGLE_LABELS,
  SHOT_TYPES,
  SPEECH_MODES,
  SPEECH_MODE_LABELS,
  type SceneSpec,
  type SpeechMode,
} from "@/lib/types";
import type { SceneStage, SceneView, StageStatus } from "@/lib/views";

const humanise = (value: string) => value.replace(/_/g, " ");

const STAGE_LABELS: Record<SceneStage, string> = {
  image: "Keyframe",
  voice: "Voice",
  video: "Clip",
};

/**
 * One storyboard scene: what exists, what is missing, and one button that does
 * whatever comes next.
 *
 * The previous version showed three equal-weight render buttons and left the
 * order dependency between them (a clip animates a keyframe; a voice needs a
 * line) for the operator to know. It also could not distinguish "not rendered"
 * from "failed" — both showed an empty thumbnail — so a broken scene was only
 * discoverable by reading the job feed and matching it up by eye.
 */
export function SceneCard({
  scene,
  onChanged,
  onRender,
  onApprove,
  storyboardApproved,
  requiresStillApproval,
  busy,
}: {
  scene: SceneView;
  onChanged: () => void | Promise<void>;
  onRender: (sceneId: string, stages: SceneStage[]) => void;
  onApprove: (sceneId: string) => void;
  storyboardApproved: boolean;
  requiresStillApproval: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<SceneSpec>(scene.spec);
  const [dialogue, setDialogue] = useState(scene.dialogue);
  const [instruction, setInstruction] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the server's copy changes underneath us — a storyboard
  // regeneration, a character swap, or an edit made in another tab. Without
  // this the editor silently keeps showing whatever it was opened with, and
  // saving would write that stale copy back.
  useEffect(() => {
    setSpec(scene.spec);
    setDialogue(scene.dialogue);
  }, [scene.spec, scene.dialogue]);

  const dirty =
    dialogue !== scene.dialogue || JSON.stringify(spec) !== JSON.stringify(scene.spec);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ scene: { spec: SceneSpec; dialogue: string } }>(
        `/api/scenes/${scene.id}`,
        {
        method: "PATCH",
        body: JSON.stringify({ spec, dialogue }),
        },
      );
      // Mark this local editor as saved immediately; waiting for the parent
      // refresh to flow back through props left the card saying "Unsaved" even
      // after the server had committed the change.
      setSpec(result.scene.spec);
      setDialogue(result.scene.dialogue);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function applyInstruction() {
    if (instruction.trim().length < 3) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ spec: SceneSpec }>(`/api/scenes/${scene.id}/instruction`, {
        method: "POST",
        body: JSON.stringify({ instruction, apply: true }),
      });
      setSpec(result.spec);
      setInstruction("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const next = nextAction(scene, storyboardApproved, requiresStillApproval);
  const failures = (["image", "voice", "video"] as const).filter(
    (stage) => scene.status[stage].state === "failed",
  );

  return (
    <div className="panel overflow-hidden">
      <div className="grid gap-4 p-4 sm:grid-cols-[200px_1fr]">
        {/* --- preview --------------------------------------------------- */}
        <div className="space-y-2">
          <div className="relative aspect-[9/16] overflow-hidden rounded-lg border border-edge bg-ink">
            {scene.video?.url && isPlayableVideo(scene.video.url) ? (
              <video src={scene.video.url} controls className="h-full w-full object-cover" />
            ) : scene.image?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sized(scene.image.url, 640)}
                alt={scene.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full place-items-center px-3 text-center text-[11px] text-muted">
                {scene.status.image.state === "failed"
                  ? "keyframe failed"
                  : scene.status.image.state === "running" ||
                      scene.status.image.state === "queued"
                    ? "rendering…"
                    : "not rendered yet"}
              </div>
            )}
          </div>

          {/* A generated clip whose format the browser cannot play still needs
              a way to reach the file — surface a direct link. */}
          {scene.video?.url && !isPlayableVideo(scene.video.url) ? (
            <a
              href={scene.video.url}
              target="_blank"
              rel="noreferrer"
              className="block text-center text-[11px] text-accent hover:underline"
            >
              open clip ↗
            </a>
          ) : null}

          {scene.audio?.url ? <audio src={scene.audio.url} controls className="w-full" /> : null}
        </div>

        {/* --- summary --------------------------------------------------- */}
        <div className="min-w-0 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">
                Scene {scene.index + 1} · {scene.durationSeconds}s
              </p>
              <h3 className="truncate font-medium">{scene.title}</h3>
            </div>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="btn btn-sm shrink-0"
            >
              {open ? "Close" : "Edit words & shot"}
            </button>
          </div>

          {/* Three steps, always in pipeline order, each clickable to run just
              that one. State is visible without opening anything. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(requiresStillApproval
              ? (["image", "voice", "video"] as const)
              : (["image"] as const)
            ).map((stage) => (
              <StagePill
                key={stage}
                stage={stage}
                status={scene.status[stage]}
                busy={busy}
                disabledReason={
                  stage === "image" && !storyboardApproved
                    ? "Approve the script and shot list first."
                    : stage !== "image" && requiresStillApproval && !scene.stillApproved
                      ? "Approve this preview still first."
                      : null
                }
                onRun={() => onRender(scene.id, [stage])}
              />
            ))}
            <div className="ml-auto flex items-center gap-2">
              {requiresStillApproval && scene.status.image.state === "done" ? (
                scene.stillApproved ? (
                  <span className="text-[11px] font-medium text-emerald-300">Still approved ✓</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy || !storyboardApproved}
                    onClick={() => onApprove(scene.id)}
                    className="btn btn-sm"
                    title={
                      storyboardApproved
                        ? "Lock this exact still for video generation"
                        : "Approve the current script and shot list first"
                    }
                  >
                    Approve still
                  </button>
                )
              ) : null}
              {next ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRender(scene.id, next.stages)}
                  className="btn btn-sm btn-primary"
                  title={next.hint}
                >
                  {next.label}
                </button>
              ) : (
                <span className="text-[11px] text-muted">Scene complete</span>
              )}
            </div>
          </div>

          {failures.length > 0 ? (
            <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-200">
              {failures.map((stage) => (
                <p key={stage}>
                  <span className="font-medium">{STAGE_LABELS[stage]} failed:</span>{" "}
                  {scene.status[stage].error ?? "unknown error"}
                </p>
              ))}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {failures.map((stage) => (
                  <button
                    key={stage}
                    type="button"
                    disabled={
                      busy ||
                      (stage === "image" && !storyboardApproved) ||
                      (stage !== "image" && requiresStillApproval && !scene.stillApproved)
                    }
                    onClick={() => onRender(scene.id, [stage])}
                    className="btn btn-sm"
                  >
                    Retry {STAGE_LABELS[stage].toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <AudioStatus meta={scene.video?.meta} />

          <div className="flex flex-wrap gap-1">
            <span className="chip">{humanise(scene.spec.shotType)}</span>
            <span className="chip">{humanise(scene.spec.cameraMove)}</span>
            <span className="chip">{IDENTITY_ANGLE_LABELS[scene.spec.subjectAngle]}</span>
            <span className="chip">{scene.spec.mood}</span>
            {scene.dialogue && scene.spec.speechMode === "voiceover" ? (
              <span className="chip">voice-over</span>
            ) : null}
          </div>

          <p className="text-sm leading-relaxed text-slate-300">{scene.readableAction}</p>
          <p className="text-xs leading-relaxed text-muted">
            {scene.spec.environment} · {scene.spec.lighting}
          </p>

          {scene.dialogue ? (
            <p className="rounded-lg border border-edge bg-ink px-3 py-2 text-sm italic text-slate-300">
              {scene.spec.speechMode === "voiceover" ? (
                <span className="not-italic text-[11px] text-muted">Narration · </span>
              ) : null}
              “{scene.dialogue}”
            </p>
          ) : (
            <p className="text-xs text-muted">Silent B-roll</p>
          )}

          {scene.image?.prompt ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer hover:text-slate-300">
                Compiled prompt used for this render
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-ink p-3 font-mono leading-relaxed">
                {scene.image.prompt}
              </pre>
            </details>
          ) : null}
        </div>
      </div>

      {/* --- editor ------------------------------------------------------- */}
      {open ? (
        <div className="space-y-4 border-t border-edge bg-ink/50 p-4">
          <div>
            <label className="label" htmlFor={`instr-${scene.id}`}>
              Director shorthand
            </label>
            <div className="flex gap-2">
              <input
                id={`instr-${scene.id}`}
                className="field"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Medium shot, smiling, holding coffee, sunrise lighting."
              />
              <button
                type="button"
                disabled={saving || instruction.trim().length < 3}
                onClick={applyInstruction}
                className="btn btn-primary shrink-0"
              >
                Apply
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLE_INSTRUCTIONS.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInstruction(example)}
                  className="chip hover:border-slate-500 hover:text-slate-200"
                >
                  {example.split(",")[0]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted">
              Shorthand is expanded into the fields below. Edit any of them directly
              afterwards.
            </p>
          </div>

          {/* Grouped rather than a flat wall of ten textareas: who the shot is
              of, where it happens, and how it is captured. */}
          <Group title="Subject">
            {/* How the line is performed. Shown even before a line exists so
                the choice is visible when one is added. */}
            <SpeechModeSelect
              value={spec.speechMode ?? "on_camera"}
              onChange={(speechMode) => setSpec({ ...spec, speechMode })}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Select
                label="Shot type"
                value={spec.shotType}
                options={SHOT_TYPES}
                onChange={(shotType) =>
                  setSpec({ ...spec, shotType: shotType as SceneSpec["shotType"] })
                }
              />
              <Select
                label="Subject angle"
                value={spec.subjectAngle}
                options={IDENTITY_ANGLES}
                onChange={(subjectAngle) =>
                  setSpec({ ...spec, subjectAngle: subjectAngle as SceneSpec["subjectAngle"] })
                }
              />
              <Select
                label="Camera move"
                value={spec.cameraMove}
                options={CAMERA_MOVES}
                onChange={(cameraMove) =>
                  setSpec({ ...spec, cameraMove: cameraMove as SceneSpec["cameraMove"] })
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Text
                label="Action"
                hint="Use {CREATOR} for the subject — that placeholder is what makes swapping work."
                value={spec.action}
                onChange={(action) => setSpec({ ...spec, action })}
              />
              <Text
                label="Motion (clip)"
                hint="Also uses {CREATOR}."
                value={spec.motion}
                onChange={(motion) => setSpec({ ...spec, motion })}
              />
              <Text
                label="Facial expression"
                value={spec.facialExpression}
                onChange={(facialExpression) => setSpec({ ...spec, facialExpression })}
              />
              <Text
                label="Pose"
                value={spec.pose}
                onChange={(pose) => setSpec({ ...spec, pose })}
              />
              <Text
                label="Dialogue"
                hint="Spoken in this scene. Leave blank for silent B-roll."
                value={dialogue}
                onChange={setDialogue}
              />
              <Text
                label="Wardrobe"
                hint="Blank inherits the creator's default outfit."
                value={spec.wardrobe}
                onChange={(wardrobe) => setSpec({ ...spec, wardrobe })}
              />
            </div>
          </Group>

          <Group title="World">
            <div className="grid gap-3 sm:grid-cols-2">
              <Text
                label="Environment"
                value={spec.environment}
                onChange={(environment) => setSpec({ ...spec, environment })}
              />
              <Text
                label="Lighting"
                value={spec.lighting}
                onChange={(lighting) => setSpec({ ...spec, lighting })}
              />
              <Text
                label="Mood"
                value={spec.mood}
                onChange={(mood) => setSpec({ ...spec, mood })}
              />
              <Text
                label="Style notes"
                value={spec.styleNotes}
                onChange={(styleNotes) => setSpec({ ...spec, styleNotes })}
              />
            </div>
          </Group>

          {error ? <p className="text-xs text-red-300">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={save}
              className="btn btn-primary"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              disabled={busy || dirty || !storyboardApproved}
              onClick={() => onRender(scene.id, ["image"])}
              className="btn"
              title={
                dirty
                  ? "Save the edits and approve the updated storyboard first"
                  : !storyboardApproved
                    ? "Approve the updated storyboard first"
                    : "Generate a replacement preview still; video remains locked"
              }
            >
              Regenerate preview still
            </button>
            <span className="text-[11px] text-muted">
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The single most useful button on the card: whatever this scene needs next.
 *
 * Returns null when there is nothing left to do, which is itself worth showing
 * — "Scene complete" is information, an always-enabled render button is not.
 */
function nextAction(
  scene: SceneView,
  storyboardApproved: boolean,
  requiresStillApproval: boolean,
): { label: string; stages: SceneStage[]; hint: string } | null {
  const { image, voice, video } = scene.status;
  const running = (s: StageStatus) => s.state === "running" || s.state === "queued";

  if (running(image) || running(voice) || running(video)) {
    return null;
  }
  if (!storyboardApproved) return null;
  if (image.state !== "done") {
    return {
      label: "Generate preview still",
      stages: ["image"],
      hint: "Generates only the still. Video remains locked until you approve it.",
    };
  }
  if (!requiresStillApproval) return null;
  if (requiresStillApproval && !scene.stillApproved) return null;
  if (voice.state === "empty" && scene.dialogue.trim()) {
    return { label: "Voice + clip", stages: ["voice", "video"], hint: "Keyframe is done." };
  }
  if (video.state !== "done") {
    return { label: "Render clip", stages: ["video"], hint: "Animates the keyframe." };
  }
  return null;
}

const PILL_STYLES: Record<StageState_, string> = {
  done: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  running: "border-sky-400/40 bg-sky-400/10 text-sky-200",
  queued: "border-sky-400/30 bg-sky-400/5 text-sky-200/80",
  failed: "border-red-400/40 bg-red-400/10 text-red-200",
  cancelled: "border-edge bg-ink text-muted",
  blocked: "border-edge bg-ink text-faint",
  empty: "border-edge bg-ink text-muted",
};

type StageState_ = StageStatus["state"];

function StagePill({
  stage,
  status,
  busy,
  disabledReason,
  onRun,
}: {
  stage: SceneStage;
  status: StageStatus;
  busy: boolean;
  disabledReason: string | null;
  onRun: () => void;
}) {
  const label = STAGE_LABELS[stage];
  const running = status.state === "running" || status.state === "queued";
  const suffix =
    status.state === "done"
      ? " ✓"
      : status.state === "running"
        ? ` ${status.progress}%`
        : status.state === "queued"
          ? " queued"
          : status.state === "failed"
            ? " ✕"
            : "";

  const title =
    disabledReason ??
    status.blockedReason ??
    status.error ??
    (status.state === "done" ? `${label} is rendered — click to render it again` : `Render ${label.toLowerCase()}`);

  return (
    <button
      type="button"
      disabled={busy || running || status.state === "blocked" || Boolean(disabledReason)}
      onClick={onRun}
      title={title}
      className={`chip transition-colors disabled:cursor-not-allowed ${PILL_STYLES[status.state]} ${
        busy || running || status.state === "blocked" || disabledReason ? "" : "hover:border-slate-500"
      }`}
    >
      {label}
      {suffix}
    </button>
  );
}

/** Mock video output is an SVG placeholder — render it as an image instead. */
function isPlayableVideo(url: string): boolean {
  return !/\.svg($|\?)/i.test(url);
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>
      {children}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {humanise(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * On camera or voice-over.
 *
 * Its own control rather than another generic Select because the two options
 * need their consequence spelled out: voice-over keeps the exact recording and
 * shows the presenter not speaking; on camera needs the clip performed from the
 * voice, and is refused under the Overlay audio mode.
 */
function SpeechModeSelect({
  value,
  onChange,
}: {
  value: SpeechMode;
  onChange: (value: SpeechMode) => void;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>Line delivery</label>
      <select
        id={id}
        className="field"
        value={value}
        onChange={(event) => onChange(event.target.value as SpeechMode)}
      >
        {SPEECH_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {SPEECH_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
      <p className="mt-0.5 text-[10px] text-muted">
        Voice-over keeps the exact recording and renders the presenter not speaking. On camera
        needs lip-synced audio; the Overlay audio mode cannot match a mouth.
      </p>
    </div>
  );
}

function Text({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="field resize-y text-xs leading-relaxed"
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="mt-0.5 text-[10px] text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * What happened to this clip's sound.
 *
 * Worth a line of UI rather than a silent fallback: "the mouth does not match"
 * and "the file has no audio at all" look identical in a thumbnail, and both
 * are things you need to know before publishing.
 */
function AudioStatus({ meta }: { meta: Record<string, unknown> | undefined }) {
  if (!meta) return null;
  const mode = meta.audioMode;
  if (typeof mode !== "string") return null;

  const note = typeof meta.audioNote === "string" ? meta.audioNote : null;
  const overrun = typeof meta.audioOverrunSeconds === "number" ? meta.audioOverrunSeconds : 0;
  const voiceSeconds =
    typeof meta.voiceDurationSeconds === "number" ? meta.voiceDurationSeconds : null;

  // `native` is the normal outcome now — the video model speaks the line itself.
  // It was missing from this map, so every in-sync clip was labelled
  // "clip + voice separate", which says the exact opposite of what happened.
  const label =
    mode === "native"
      ? "in sync"
      : mode === "lipsync"
        ? "lip-synced"
        : mode === "mux"
          ? "voice attached"
          : "clip + voice separate";
  const tone = mode === "separate" ? "text-amber-300/90" : "text-muted";

  return (
    <div className={`space-y-0.5 text-[11px] ${tone}`}>
      <div>
        Sound: {label}
        {voiceSeconds ? ` · voice ${voiceSeconds.toFixed(1)}s` : ""}
      </div>
      {overrun > 0 ? (
        <div className="text-amber-300/90">
          narration runs {overrun.toFixed(1)}s past the clip — shorten this line
        </div>
      ) : null}
      {typeof meta.voiceSpeedup === "number" && meta.voiceSpeedup > 1 ? (
        <div>
          tightened {Math.round((meta.voiceSpeedup - 1) * 100)}% to fit the shot
        </div>
      ) : null}
      {/* The note explains a system-wide condition (no ffmpeg, a local URL) and
          is identical on every scene. Printed in full on each card it was three
          lines of repeated grey text; behind a summary it is one word. */}
      {note ? (
        <details>
          <summary className="cursor-pointer text-faint hover:text-slate-300">why</summary>
          <p className="mt-1 text-faint">{note}</p>
        </details>
      ) : null}
    </div>
  );
}
