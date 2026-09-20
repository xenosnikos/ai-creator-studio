"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { LookPicker } from "@/components/LookPicker";
import { VoicePicker } from "@/components/VoicePicker";
import { api, fileToDataUrl, videoToFrames } from "@/lib/client";
import type { CreatorLook } from "@/lib/look";
import { DEFAULT_VOICE, type Creator, type VoiceConfig } from "@/lib/types";

/**
 * Creator intake.
 *
 * Two modes, one output. "Import" reads uploaded photos into a locked identity
 * block; "Synthesize" invents the person from a persona description and renders
 * a seed portrait. Either way the creator ends up with the same identity kit.
 */
export default function NewCreatorPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"import" | "synth">("import");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [persona, setPersona] = useState("");
  const [appearanceNotes, setAppearanceNotes] = useState("");
  const [look, setLook] = useState<CreatorLook>({});
  const [images, setImages] = useState<string[]>([]);
  const [voice, setVoice] = useState<VoiceConfig>(DEFAULT_VOICE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickFiles(fileList: FileList | null) {
    if (!fileList) return;
    setError(null);
    const files = Array.from(fileList).slice(0, 10 - images.length);
    try {
      // Photos come in as-is; a video is reduced to a handful of stills first,
      // because the identity pipeline only ever consumes stills.
      const collected = await Promise.all(
        files.map((file) =>
          file.type.startsWith("video/") ? videoToFrames(file, 4) : fileToDataUrl(file),
        ),
      );
      setImages((current) => [...current, ...collected.flat()].slice(0, 10));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Give the creator a name.");
      return;
    }
    if (mode === "import" && images.length === 0) {
      setError("Upload at least one reference photo, or switch to Synthesize.");
      return;
    }

    setBusy(true);
    try {
      const result = await api<{ creator: Creator }>("/api/creators", {
        method: "POST",
        body: JSON.stringify({
          name,
          category,
          persona,
          referenceImages: mode === "import" ? images : [],
          appearanceNotes: appearanceNotes || undefined,
          look,
          voice,
          // Always. A creator without their close-up and full-body frames is
          // not usable yet — every scene render pulls one of them as its
          // anchor — so making them a separate click just meant every creator
          // sat half-finished until someone noticed. A synthesized creator
          // waits for its seed portrait first; the sheet job handles that
          // itself rather than racing it.
          buildIdentitySheet: true,
        }),
      });
      router.push(`/creators/${result.creator.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="page-title">New creator</h1>
        <p className="page-subtitle">
          The references (or the persona) are read into a locked identity description.
          That description, plus the reference images, is what every later render is
          conditioned on.
        </p>
      </div>

      <div className="panel space-y-5 p-5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("import")}
            className={`btn flex-1 ${mode === "import" ? "btn-primary" : ""}`}
          >
            Import from photos
          </button>
          <button
            type="button"
            onClick={() => setMode("synth")}
            className={`btn flex-1 ${mode === "synth" ? "btn-primary" : ""}`}
          >
            Synthesize from persona
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Mia Tanaka"
            />
          </div>
          <div>
            <label className="label" htmlFor="category">
              Category
            </label>
            <input
              id="category"
              className="field"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Travel &amp; food"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="persona">
            Persona
          </label>
          <textarea
            id="persona"
            className="field h-24 resize-y"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder="Warm, fast-talking city guide. Opinionated about food, allergic to tourist traps. Speaks in short punchy sentences."
          />
          <p className="mt-1 text-[11px] text-muted">
            Drives tone of voice in scripts. Never used to describe appearance.
          </p>
        </div>

        {mode === "import" ? (
          <div>
            <label className="label" htmlFor="refs">
              Reference photos or video ({images.length}/10)
            </label>
            <input
              id="refs"
              type="file"
              accept="image/*,video/*"
              multiple
              className="field file:mr-3 file:rounded file:border-0 file:bg-edge file:px-2 file:py-1 file:text-slate-200"
              onChange={(event) => void onPickFiles(event.target.files)}
            />
            <p className="mt-1 text-[11px] text-muted">
              Best results: 3–6 photos of the same person from different angles, clear face,
              varied lighting. A short video works too — four frames are taken from across
              the middle of it, right here in the browser, and the video itself is never
              uploaded.
            </p>
            {images.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {images.map((src, index) => (
                  <div key={src.slice(-24) + index} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={`Reference ${index + 1}`}
                      className="h-20 w-20 rounded-lg border border-edge object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setImages((c) => c.filter((_, i) => i !== index))}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-edge bg-ink text-xs text-muted hover:text-red-300"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="label">Appearance</p>
              <p className="mb-3 text-[11px] text-muted">
                Pick what matters and leave the rest on “Any”. Each choice is turned into
                wording the image models actually respond to — describing a body mildly is
                what makes it come back average.
              </p>
              <LookPicker value={look} onChange={setLook} />
            </div>

            <div>
              <label className="label" htmlFor="appearance">
                Anything else (optional)
              </label>
              <textarea
                id="appearance"
                className="field h-20 resize-y"
                value={appearanceNotes}
                onChange={(event) => setAppearanceNotes(event.target.value)}
                placeholder="Freckles across the nose, wears technical outerwear, a small scar through one eyebrow."
              />
              <p className="mt-1 text-[11px] text-muted">
                Added after the picks above, so it can add detail or override them. The rest is
                invented for you, then a seed portrait is rendered and the identity sheet built
                from it.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-edge bg-ink p-4">
          <p className="section-title">Voice</p>
          <VoicePicker
            voiceId={voice.voiceId}
            voiceLabel={voice.label}
            onPick={(picked) => setVoice({ ...voice, voiceId: picked.id, label: picked.label })}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <Slider
              label="Stability"
              hint="Higher = more consistent take-to-take"
              value={voice.stability}
              min={0}
              max={1}
              onChange={(stability) => setVoice({ ...voice, stability })}
            />
            <Slider
              label="Similarity"
              hint="Adherence to the reference timbre"
              value={voice.similarityBoost}
              min={0}
              max={1}
              onChange={(similarityBoost) => setVoice({ ...voice, similarityBoost })}
            />
            <Slider
              label="Speed"
              hint="Delivery pace"
              value={voice.speed}
              min={0.7}
              max={1.2}
              onChange={(speed) => setVoice({ ...voice, speed })}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            These settings are locked onto the creator and reused for every line in every
            project — that is what keeps cadence and tone identical across videos.
          </p>
        </div>

        {error ? (
          <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <button type="button" onClick={submit} disabled={busy} className="btn btn-primary w-full">
          {busy ? "Building identity kit…" : "Create creator"}
        </button>
      </div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-slate-300">{label}</span>
        <span className="font-mono text-[11px] text-muted">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-emerald-400"
      />
      <p className="mt-0.5 text-[10px] leading-tight text-muted">{hint}</p>
    </div>
  );
}
