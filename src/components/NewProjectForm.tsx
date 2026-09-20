"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { VideoStylePicker } from "@/components/VideoStylePicker";
import { api, fileToDataUrl } from "@/lib/client";
import type { VideoStyle } from "@/lib/video-style";
import {
  ASPECT_RATIOS,
  CAPTURE_LOOKS,
  CAPTURE_LOOK_LABELS,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_SECONDS,
  MAX_PHOTO_COUNT,
  PHOTO_FORMATS,
  VIDEO_DURATION_PRESETS,
  clampVideoDuration,
  type AspectRatio,
  type CaptureLook,
  MUSIC_LEVEL,
  MUSIC_MOODS,
  MUSIC_MOOD_LABELS,
  type MusicMood,
  type ProjectKind,
  type Project,
  ROOM_TONES,
  ROOM_TONE_LABELS,
  type RoomTone,
  type VideoDuration,
} from "@/lib/types";

interface CreatorOption {
  id: string;
  name: string;
  category: string;
  referenceCount: number;
}

interface Example {
  prompt: string;
  category: string;
  duration: VideoDuration;
  globalStyle: string;
}

/**
 * Step 1 of the workflow: pick a creator, write a brief, attach optional
 * background / style references. Submitting queues the storyboard job.
 */
export function NewProjectForm({
  creators,
  defaultCreatorId,
  defaultPrompt = "",
  examples,
}: {
  creators: CreatorOption[];
  defaultCreatorId: string;
  defaultPrompt?: string;
  examples: Example[];
}) {
  const router = useRouter();
  const [creatorId, setCreatorId] = useState(defaultCreatorId);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [duration, setDuration] = useState<VideoDuration>(30);
  const [requestedSceneCount, setRequestedSceneCount] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [look, setLook] = useState<CaptureLook>("social");
  const [musicMood, setMusicMood] = useState<MusicMood>("off");
  const [roomTone, setRoomTone] = useState<RoomTone>("light");
  const [globalStyle, setGlobalStyle] = useState("");
  const [backgroundRefs, setBackgroundRefs] = useState<string[]>([]);
  const [styleRefs, setStyleRefs] = useState<string[]>([]);
  const [wardrobeRefs, setWardrobeRefs] = useState<string[]>([]);
  const [videoStyle, setVideoStyle] = useState<VideoStyle>({});
  const [script, setScript] = useState("");
  const [kind, setKind] = useState<ProjectKind>("video");
  const [photoCount, setPhotoCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = creators.find((c) => c.id === creatorId);

  function chooseDuration(value: number) {
    const next = clampVideoDuration(value);
    setDuration(next);
    if (
      requestedSceneCount &&
      (next < requestedSceneCount * 3 || next > requestedSceneCount * 15)
    ) {
      setRequestedSceneCount(null);
    }
  }

  function chooseSceneCount(value: number | null) {
    setRequestedSceneCount(value);
    if (value) {
      // Keep the choice renderable immediately. One shot is necessarily at
      // most 15 seconds because that is the provider's per-clip ceiling.
      setDuration(clampVideoDuration(Math.max(value * 3, Math.min(value * 15, duration))));
    }
  }

  async function pick(
    fileList: FileList | null,
    set: (updater: (current: string[]) => string[]) => void,
  ) {
    if (!fileList?.length) return;
    const urls = await Promise.all(Array.from(fileList).slice(0, 6).map(fileToDataUrl));
    set((current) => [...current, ...urls].slice(0, 6));
  }

  async function submit() {
    setError(null);
    if (prompt.trim().length < 5) {
      setError("Describe what the video should be about.");
      return;
    }
    if (
      kind === "video" &&
      requestedSceneCount &&
      (duration < requestedSceneCount * 3 || duration > requestedSceneCount * 15)
    ) {
      setError(
        `${requestedSceneCount} scene${requestedSceneCount === 1 ? "" : "s"} can cover ` +
          `${requestedSceneCount * 3}-${requestedSceneCount * 15} seconds. Adjust the duration or choose Auto.`,
      );
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || "Untitled project",
          prompt,
          transcript: script.trim(),
          creatorId,
          settings: {
            kind,
            photoCount,
            aspectRatio,
            imageQuality: "high",
            targetDurationSeconds: clampVideoDuration(duration),
            requestedSceneCount:
              kind === "video" ? requestedSceneCount ?? undefined : undefined,
            // Not a form field: the video model renders at 720p and rejects
            // anything higher, so offering a choice only misrepresented it.
            videoResolution: "720p",
            globalStyle,
            look,
            videoStyle,
            music: { mood: kind === "photo" ? "off" : musicMood, level: MUSIC_LEVEL },
            roomTone: kind === "photo" ? "off" : roomTone,
          },
          backgroundRefs,
          styleRefs,
          wardrobeRefs,
          autoStoryboard: true,
          // Creation stops after the editable storyboard. Preview stills and
          // clips each have their own explicit approval later.
          autoRender: false,
        }),
      });
      router.push(`/projects/${result.project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="page-title">New project</h1>
        <p className="page-subtitle">
          First create an editable storyboard and script. Nothing visual is generated until you
          approve them; video generation stays locked until you also approve every preview still.
        </p>
      </div>

      <div className="panel space-y-5 p-5">
        {/* What this project makes, first — it changes the meaning of half the
            fields below, so asking afterwards would be asking too late. */}
        <div>
          <label className="label">Output</label>
          <div className="grid grid-cols-2 gap-2">
            <KindOption
              active={kind === "video"}
              title="Video"
              detail="Storyboard, script, voice and clips"
              onClick={() => {
                setKind("video");
                setAspectRatio("9:16");
              }}
            />
            <KindOption
              active={kind === "photo"}
              title="Photo set"
              detail="Post-ready stills, no dialogue"
              onClick={() => {
                setKind("photo");
                setAspectRatio("4:5");
              }}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="creator">
            Creator
          </label>
          <select
            id="creator"
            className="field"
            value={creatorId}
            onChange={(event) => setCreatorId(event.target.value)}
          >
            {creators.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {creator.name}
                {creator.category ? ` — ${creator.category}` : ""}
                {creator.referenceCount === 0 ? " (no references yet)" : ""}
              </option>
            ))}
          </select>
          {selected && selected.referenceCount === 0 ? (
            <p className="mt-1 text-[11px] text-amber-300">
              This creator has no identity references, so renders will fail. Build their
              identity sheet first.
            </p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="prompt">
            Brief
          </label>
          <textarea
            id="prompt"
            className="field h-24 resize-y"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Creator walking through downtown Tokyo explaining the best ramen restaurants."
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {examples.map((example) => (
              <button
                key={example.prompt}
                type="button"
                onClick={() => {
                  setPrompt(example.prompt);
                  chooseDuration(example.duration);
                  setGlobalStyle(example.globalStyle);
                }}
                className="chip hover:border-slate-500 hover:text-slate-200"
              >
                {example.category}
              </button>
            ))}
          </div>
        </div>

        {kind === "photo" ? null : (
          <div>
            <label className="label" htmlFor="script">
              Script <span className="font-normal normal-case text-faint">— optional</span>
            </label>
            <textarea
              id="script"
              className="field h-24 resize-y"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              placeholder="Leave blank and one is written from your brief. Type here and it is spoken word for word."
            />
            <p className="help mt-1">
              This is what the creator actually says. Written here, it is used verbatim and the
              shots are built to fit it — roughly {Math.round(duration * 2.5)} words for{" "}
              {duration} seconds.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="title">
              Title (optional)
            </label>
            <input
              id="title"
              className="field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Named for you if you leave this blank"
            />
          </div>
          <div>
            <label className="label" htmlFor="style">
              Global visual style
            </label>
            <input
              id="style"
              className="field"
              value={globalStyle}
              onChange={(event) => setGlobalStyle(event.target.value)}
              placeholder="cinematic neon night, anamorphic flare, 35mm"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={kind === "photo" ? "hidden" : ""}>
            <label className="label" htmlFor="duration">
              Duration
            </label>
            <div className="flex gap-1.5">
              {VIDEO_DURATION_PRESETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => chooseDuration(option)}
                  className={`btn btn-sm flex-1 ${duration === option ? "btn-primary" : ""}`}
                >
                  {option}s
                </button>
              ))}
              {/* The presets are shortcuts, not the choice. Anything from one
                  renderable clip up to a minute and a half is valid, and a
                  brief that wants 22 seconds should not have to round to 30. */}
              <input
                id="duration"
                type="number"
                className="field w-20 text-center"
                min={MIN_VIDEO_SECONDS}
                max={MAX_VIDEO_SECONDS}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
                onBlur={() => chooseDuration(duration)}
                aria-label="Custom duration in seconds"
              />
            </div>
            <p className="help mt-1">
              {MIN_VIDEO_SECONDS}–{MAX_VIDEO_SECONDS}s. Longer pieces are cut into more
              scenes — the model renders at most 15 seconds in one shot.
            </p>
          </div>
          {kind === "photo" ? (
            <div>
              <label className="label" htmlFor="count">
                How many images
              </label>
              <div className="flex gap-1.5">
                {[1, 3, 4, 6].map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setPhotoCount(option)}
                    className={`btn btn-sm flex-1 ${photoCount === option ? "btn-primary" : ""}`}
                  >
                    {option}
                  </button>
                ))}
                <input
                  id="count"
                  type="number"
                  min={1}
                  max={MAX_PHOTO_COUNT}
                  className="field w-16 text-center"
                  value={photoCount}
                  onChange={(event) => setPhotoCount(Number(event.target.value))}
                  onBlur={() =>
                    setPhotoCount(Math.max(1, Math.min(MAX_PHOTO_COUNT, photoCount || 1)))
                  }
                  aria-label="Number of images"
                />
              </div>
              <p className="help mt-1">
                Each one is a separate post — different framing, angle and moment, same person.
              </p>
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="aspect">
              {kind === "photo" ? "Format" : "Aspect ratio"}
            </label>
            <select
              id="aspect"
              className="field"
              value={aspectRatio}
              onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
            >
              {kind === "photo"
                ? PHOTO_FORMATS.map((format) => (
                    <option key={format.ratio} value={format.ratio}>
                      {format.label}
                    </option>
                  ))
                : ASPECT_RATIOS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                      {option === "9:16" ? " (Reels / TikTok / Shorts)" : ""}
                      {option === "1:1" ? " (feed)" : ""}
                      {option === "16:9" ? " (landscape)" : ""}
                    </option>
                  ))}
            </select>
          </div>
        </div>

        {kind === "video" ? (
          <div>
            <label className="label">Number of scenes</label>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
              <button
                type="button"
                onClick={() => chooseSceneCount(null)}
                className={`btn btn-sm ${requestedSceneCount === null ? "btn-primary" : ""}`}
              >
                Auto
              </button>
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => chooseSceneCount(count)}
                  className={`btn btn-sm ${requestedSceneCount === count ? "btn-primary" : ""}`}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="help mt-1">
              {requestedSceneCount
                ? `Exactly ${requestedSceneCount} scene${requestedSceneCount === 1 ? "" : "s"}. ` +
                  `${requestedSceneCount === 1 ? "A single continuous shot is limited to 15 seconds." : "The storyboard writer cannot add extra cuts."}`
                : "Auto uses the fewest cuts the duration and story need. Pick 1 for one continuous shot."}
            </p>
          </div>
        ) : null}

        <div>
          <label className="label" htmlFor="look">
            Look
          </label>
          <select
            id="look"
            className="field"
            value={look}
            onChange={(event) => setLook(event.target.value as CaptureLook)}
          >
            {CAPTURE_LOOKS.map((option) => (
              <option key={option} value={option}>
                {CAPTURE_LOOK_LABELS[option]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            Phone is the realistic one. Real posts are filmed on a front camera in whatever
            light is around — matching that is what stops a render reading as AI. Pick
            cinematic only when the piece is meant to look produced.
          </p>
        </div>

        {kind === "photo" ? null : (
          <div>
            <label className="label" htmlFor="music">
              Background music
            </label>
            <select
              id="music"
              className="field"
              value={musicMood}
              onChange={(event) => setMusicMood(event.target.value as MusicMood)}
            >
              {MUSIC_MOODS.map((option) => (
                <option key={option} value={option}>
                  {MUSIC_MOOD_LABELS[option]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              Scored once across the finished video, so it does not restart at every cut, and
              ducked under the narration so the words stay clear. Off is a fair default for
              talking-head pieces — music helps a montage more than it helps a face talking.
            </p>
          </div>
        )}

        {kind === "photo" ? null : (
          <div>
            <label className="label" htmlFor="room-tone">
              Room sound
            </label>
            <select
              id="room-tone"
              className="field"
              value={roomTone}
              onChange={(event) => setRoomTone(event.target.value as RoomTone)}
            >
              {ROOM_TONES.map((option) => (
                <option key={option} value={option}>
                  {ROOM_TONE_LABELS[option]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              A generated voice comes back with no room around it and pure silence between the
              words, and that is what makes it read as AI before anyone judges the voice. This
              adds the reflections and the faint air a real recording has. Leave it on light.
            </p>
          </div>
        )}


        {/* The video's own direction. Separate from the creator's look, which
            is fixed for their lifetime — this is what THIS post is. */}
        <div className="border-t border-edge pt-5">
          <p className="label">Direction for this {kind === "photo" ? "shoot" : "video"}</p>
          <p className="help mb-3">
            Optional. Anything left on "Any" is decided by your brief instead.
          </p>
          <VideoStylePicker value={videoStyle} onChange={setVideoStyle} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <RefPicker
            id="wardrobe-refs"
            label="Outfit"
            hint="A photo of the clothes to wear. Used as the garment itself, not a mood board."
            values={wardrobeRefs}
            onPick={(files) => pick(files, setWardrobeRefs)}
            onRemove={(index) =>
              setWardrobeRefs((current) => current.filter((_, i) => i !== index))
            }
          />
          <RefPicker
            id="bg-refs"
            label="Place"
            hint="Photos of the actual room or street. Every scene is built to match them."
            values={backgroundRefs}
            onPick={(files) => pick(files, setBackgroundRefs)}
            onRemove={(index) =>
              setBackgroundRefs((current) => current.filter((_, i) => i !== index))
            }
          />
          <RefPicker
            id="style-refs"
            label="Style"
            hint="Grade, film stock, rendering feel."
            values={styleRefs}
            onPick={(files) => pick(files, setStyleRefs)}
            onRemove={(index) => setStyleRefs((current) => current.filter((_, i) => i !== index))}
          />
        </div>

        {error ? (
          <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <button type="button" onClick={submit} disabled={busy} className="btn btn-primary w-full">
          {busy
            ? "Creating…"
            : kind === "photo"
              ? `Create ${photoCount}-shot plan for review`
              : "Create storyboard for review"}
        </button>
        <p className="text-center text-[11px] text-muted">
          This button creates the plan only. It does not spend on preview images or video.
        </p>
      </div>
    </div>
  );
}

function RefPicker({
  id,
  label,
  hint,
  values,
  onPick,
  onRemove,
}: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  onPick: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept="image/*"
        multiple
        className="field file:mr-3 file:rounded file:border-0 file:bg-edge file:px-2 file:py-1 file:text-slate-200"
        onChange={(event) => onPick(event.target.files)}
      />
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((src, index) => (
            <button
              key={src.slice(-24) + index}
              type="button"
              onClick={() => onRemove(index)}
              title="Remove"
              className="relative"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt=""
                className="h-12 w-12 rounded border border-edge object-cover opacity-80 hover:opacity-40"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One of the two output choices.
 *
 * A pair of large targets rather than a select: this is the decision that
 * reshapes the rest of the form, and a dropdown would hide it among fields it
 * governs.
 */
function KindOption({
  active,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-[var(--radius)] border p-3 text-left transition ${
        active
          ? "border-accent/50 bg-accent/[0.08]"
          : "border-edge bg-raised hover:border-edge-strong"
      }`}
    >
      <span className={`block text-sm font-medium ${active ? "text-accent" : ""}`}>{title}</span>
      <span className="mt-0.5 block text-[11px] leading-snug text-muted">{detail}</span>
    </button>
  );
}
