"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/client";
import type { VoiceOption } from "@/lib/providers/types";

/**
 * Choosing a voice.
 *
 * This was a bare `<select>` of twelve stock voices, which is how a project
 * ends up sounding synthetic: those voices are the ones every account ships
 * with, and they are recognisable as text-to-speech to anyone who has heard
 * them before. On a paid plan the shared Voice Library is reachable — thousands
 * of voices cloned from real people — so the job here is to make that catalogue
 * searchable rather than to list a fixed dozen.
 *
 * The preview button is the point of the component. A voice cannot be judged
 * from a name, and without a sample the first time you hear it is in a finished
 * render you have already paid for.
 */
export function VoicePicker({
  voiceId,
  voiceLabel,
  onPick,
}: {
  voiceId: string;
  voiceLabel: string;
  onPick: (voice: { id: string; label: string }) => void;
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [showStock, setShowStock] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refetch as the filters change, debounced so typing does not fire a search
  // per keystroke against a remote catalogue.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (gender) params.set("gender", gender);

      api<{ voices: VoiceOption[] }>(`/api/voices?${params}`)
        .then((result) => {
          if (cancelled) return;
          setVoices(result.voices);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, gender]);

  // Never leave a sample playing after the component goes away.
  useEffect(() => {
    return () => audioRef.current?.pause();
  }, []);

  function preview(voice: VoiceOption) {
    if (!voice.previewUrl) return;
    audioRef.current?.pause();

    if (playing === voice.id) {
      setPlaying(null);
      return;
    }
    const audio = new Audio(voice.previewUrl);
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    audioRef.current = audio;
    void audio.play().catch(() => setPlaying(null));
    setPlaying(voice.id);
  }

  // The bound voice may not be in the current results — it can be a library
  // voice that today's filters exclude. Show it anyway, so the selection is
  // always visible and never silently reassigned.
  const selectedInList = voices.some((v) => v.id === voiceId);

  /**
   * The stock voices are folded away rather than listed.
   *
   * They are the set every ElevenLabs account ships with, and the reason
   * finished videos sounded synthetic — so they should not be twenty rows of
   * the thing you scroll past to reach the good ones.
   *
   * The currently selected voice is always shown even while the rest stay
   * folded. That case is the common one rather than an edge: the app's default
   * voice is itself a stock voice, so expanding the whole group whenever the
   * selection sits in it would mean the group is open on every new creator,
   * which is the situation this is meant to avoid.
   */
  const hiddenStock = voices.filter((v) => v.source === "stock" && v.id !== voiceId);
  const visible = voices.filter(
    (v) => v.source !== "stock" || showStock || v.id === voiceId,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          className="field flex-1 min-w-[10rem]"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search all voices — calm, deep, british, irish…"
        />
        <select
          className="field w-auto"
          value={gender}
          onChange={(event) => setGender(event.target.value)}
        >
          <option value="">Any voice</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="neutral">Neutral</option>
        </select>
      </div>

      {!selectedInList ? (
        <p className="text-[11px] text-muted">
          Currently selected: <span className="text-slate-300">{voiceLabel}</span>
        </p>
      ) : null}

      {failed ? (
        <p className="note note-warn text-xs">
          Could not load the voice catalogue. Check the ElevenLabs key on the Settings page —
          the creator can still be saved with the voice shown above.
        </p>
      ) : null}

      <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-edge bg-ink p-1">
        {loading && voices.length === 0 ? (
          <p className="p-3 text-xs text-muted">Loading voices…</p>
        ) : null}

        {!loading && voices.length === 0 && !failed ? (
          <p className="p-3 text-xs text-muted">
            No voices match that search. Clear the filters to see the full catalogue.
          </p>
        ) : null}

        {visible.map((voice, index) => {
          const selected = voice.id === voiceId;
          // A heading each time the tier changes, so it is obvious which of
          // these are the realistic ones and which are the stock set.
          const heading =
            visible[index - 1]?.source !== voice.source ? GROUP_LABELS[voice.source] : null;

          return (
            <div key={voice.id}>
              {heading ? (
                <p className="px-2 pb-1 pt-3 text-[11px] uppercase tracking-wide text-muted">
                  {heading}
                </p>
              ) : null}
            <div
              className={`flex items-center gap-2 rounded-md px-2 py-2 ${
                selected ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-white/5"
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onPick({ id: voice.id, label: voice.label })}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-slate-200">{voice.label}</span>
                  {/* Only marked where it is not implied by the group heading —
                      a badge on every row of a "Premium" group is noise. */}
                  {voice.premium && voice.source !== "library" ? (
                    <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] uppercase tracking-wide text-accent">
                      Premium
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {describe(voice) || " "}
                </span>
              </button>

              {voice.previewUrl ? (
                <button
                  type="button"
                  className="btn-ghost shrink-0 px-2 py-1 text-xs"
                  onClick={() => preview(voice)}
                  aria-label={`Play a sample of ${voice.label}`}
                >
                  {playing === voice.id ? "Stop" : "Play"}
                </button>
              ) : null}
            </div>
            </div>
          );
        })}

        {hiddenStock.length > 0 && !showStock ? (
          <button
            type="button"
            className="w-full px-2 py-2 text-left text-[11px] text-muted hover:text-slate-300"
            onClick={() => setShowStock(true)}
          >
            Show {hiddenStock.length} standard voices — the default set, more synthetic
          </button>
        ) : null}
      </div>
    </div>
  );
}

const GROUP_LABELS: Record<VoiceOption["source"], string> = {
  account: "Your voices",
  library: "Premium — studio-cloned real voices, picked for social video",
  stock: "Standard voices (these sound more synthetic)",
};

/** The descriptors the provider supplies, minus the ones it left blank. */
function describe(voice: VoiceOption): string {
  return [voice.descriptive, voice.gender, voice.age, voice.accent, voice.useCase]
    .filter(Boolean)
    .map((part) => String(part).replace(/_/g, " "))
    .join(" · ");
}
