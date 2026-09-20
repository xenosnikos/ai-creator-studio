"use client";

import {
  ENDINGS,
  ENERGIES,
  HOOKS,
  OUTFITS,
  PACINGS,
  SETTINGS,
  TIMES_OF_DAY,
  VIDEO_FORMATS,
  VIDEO_LABELS,
  describeVideoStyle,
  type VideoStyle,
} from "@/lib/video-style";

/**
 * Structured direction for one video.
 *
 * The sibling of the creator's look picker, and deliberately not the same
 * questions: this is what *this post* is, not who the presenter is. The picks
 * go to the storyboard writer rather than the renderer, which is why place and
 * pacing belong here — a storyboard written for the wrong pace cannot be fixed
 * by the camera afterwards.
 *
 * Everything is optional. "Any" hands the decision back to the brief.
 */
export function VideoStylePicker({
  value,
  onChange,
}: {
  value: VideoStyle;
  onChange: (next: VideoStyle) => void;
}) {
  const set = <K extends keyof VideoStyle>(key: K, raw: string) =>
    onChange({ ...value, [key]: (raw || undefined) as VideoStyle[K] });

  const preview = describeVideoStyle(value);

  return (
    <div className="space-y-4">
      <Group title="What kind of video">
        <Pick
          label="Format"
          value={value.format ?? ""}
          options={VIDEO_FORMATS}
          labels={VIDEO_LABELS.format}
          onChange={(v) => set("format", v)}
        />
        <Pick
          label="Pacing"
          value={value.pacing ?? ""}
          options={PACINGS}
          labels={VIDEO_LABELS.pacing}
          onChange={(v) => set("pacing", v)}
        />
        <Pick
          label="Energy"
          value={value.energy ?? ""}
          options={ENERGIES}
          labels={VIDEO_LABELS.energy}
          onChange={(v) => set("energy", v)}
        />
      </Group>

      <Group title="Where and when">
        <Pick
          label="Setting"
          value={value.setting ?? ""}
          options={SETTINGS}
          labels={VIDEO_LABELS.setting}
          onChange={(v) => set("setting", v)}
        />
        <Pick
          label="Time of day"
          value={value.timeOfDay ?? ""}
          options={TIMES_OF_DAY}
          labels={VIDEO_LABELS.timeOfDay}
          onChange={(v) => set("timeOfDay", v)}
        />
        <Pick
          label="Outfit"
          value={value.outfit ?? ""}
          options={OUTFITS}
          labels={VIDEO_LABELS.outfit}
          onChange={(v) => set("outfit", v)}
        />
      </Group>

      <Group title="Structure">
        <Pick
          label="Opening"
          value={value.hook ?? ""}
          options={HOOKS}
          labels={VIDEO_LABELS.hook}
          onChange={(v) => set("hook", v)}
        />
        <Pick
          label="Ending"
          value={value.ending ?? ""}
          options={ENDINGS}
          labels={VIDEO_LABELS.ending}
          onChange={(v) => set("ending", v)}
        />
      </Group>

      {/* Same reasoning as the creator picker: show the operator the brief their
          picks produce, so the form is not a black box. */}
      {preview ? (
        <div className="rounded-lg border border-edge bg-ink p-3">
          <p className="label">This becomes</p>
          <p className="whitespace-pre-line text-xs leading-relaxed text-muted">{preview}</p>
        </div>
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>
      <div className="grid gap-3 sm:grid-cols-3">{children}</div>
    </div>
  );
}

function Pick<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </div>
  );
}
