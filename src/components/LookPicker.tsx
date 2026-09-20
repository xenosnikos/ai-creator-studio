"use client";

import {
  AGE_BANDS,
  APPEALS,
  BODY_TYPES,
  BUSTS,
  EYE_COLOURS,
  FACE_SHAPES,
  HAIR_COLOURS,
  HAIR_LENGTHS,
  HEIGHTS,
  HIPS,
  LABELS,
  LOOK_STYLES,
  SEXES,
  SKIN_TONES,
  describeLook,
  type CreatorLook,
} from "@/lib/look";

/**
 * Structured appearance picks.
 *
 * Free text works only if the operator happens to phrase things the way an
 * image model responds to, and they usually do not — "curvy" gets averaged
 * away where "very large bust, wide hips, full rounded rear" does not. Picking
 * a label instead means the wording that lands is chosen here rather than
 * rediscovered by each operator.
 *
 * Everything is optional; "Any" leaves the field for the identity writer to
 * invent.
 */
export function LookPicker({
  value,
  onChange,
}: {
  value: CreatorLook;
  onChange: (next: CreatorLook) => void;
}) {
  const set = <K extends keyof CreatorLook>(key: K, raw: string) =>
    onChange({ ...value, [key]: (raw || undefined) as CreatorLook[K] });

  const preview = describeLook(value);

  return (
    <div className="space-y-4">
      <Group title="Who">
        <Pick
          label="Sex"
          value={value.sex ?? ""}
          options={SEXES}
          labels={LABELS.sex}
          onChange={(v) => set("sex", v)}
        />
        <Pick
          label="Age"
          value={value.ageBand ?? ""}
          options={AGE_BANDS}
          labels={LABELS.ageBand}
          onChange={(v) => set("ageBand", v)}
        />
        <Pick
          label="Overall look"
          value={value.style ?? ""}
          options={LOOK_STYLES}
          labels={LABELS.style}
          onChange={(v) => set("style", v)}
        />
        {/* Separate from body type because it is a separate question: body type
            is the shape, this is how hard to push attractiveness. Picking a
            shape without this is what produced creators who matched the
            measurements and still were not hot. */}
        <Pick
          label="How sexy"
          value={value.appeal ?? ""}
          options={APPEALS}
          labels={LABELS.appeal}
          onChange={(v) => set("appeal", v)}
        />
      </Group>

      <Group title="Body">
        <Pick
          label="Body type"
          value={value.bodyType ?? ""}
          options={BODY_TYPES}
          labels={LABELS.bodyType}
          onChange={(v) => set("bodyType", v)}
        />
        <Pick
          label="Height"
          value={value.height ?? ""}
          options={HEIGHTS}
          labels={LABELS.height}
          onChange={(v) => set("height", v)}
        />
        <Pick
          label="Hips / rear"
          value={value.hips ?? ""}
          options={HIPS}
          labels={LABELS.hips}
          onChange={(v) => set("hips", v)}
        />
        {/* Only meaningful for one of the two, and offering it regardless made
            the form read as if it had been written without thinking. */}
        {value.sex !== "male" ? (
          <Pick
            label="Bust"
            value={value.bust ?? ""}
            options={BUSTS}
            labels={LABELS.bust}
            onChange={(v) => set("bust", v)}
          />
        ) : null}
      </Group>

      <Group title="Face and hair">
        <Pick
          label="Face shape"
          value={value.faceShape ?? ""}
          options={FACE_SHAPES}
          labels={LABELS.faceShape}
          onChange={(v) => set("faceShape", v)}
        />
        <Pick
          label="Eyes"
          value={value.eyeColour ?? ""}
          options={EYE_COLOURS}
          labels={LABELS.eyeColour}
          onChange={(v) => set("eyeColour", v)}
        />
        <Pick
          label="Skin tone"
          value={value.skinTone ?? ""}
          options={SKIN_TONES}
          labels={LABELS.skinTone}
          onChange={(v) => set("skinTone", v)}
        />
        <Pick
          label="Hair colour"
          value={value.hairColour ?? ""}
          options={HAIR_COLOURS}
          labels={LABELS.hairColour}
          onChange={(v) => set("hairColour", v)}
        />
        <Pick
          label="Hair length"
          value={value.hairLength ?? ""}
          options={HAIR_LENGTHS}
          labels={LABELS.hairLength}
          onChange={(v) => set("hairLength", v)}
        />
      </Group>

      {/* Shows the operator the exact brief their picks produce, so the form is
          not a black box and they can see what to override in the free text. */}
      {preview ? (
        <div className="rounded-lg border border-edge bg-ink p-3">
          <p className="label">This becomes</p>
          <p className="text-xs leading-relaxed text-muted">{preview}</p>
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
      <select
        className="field"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
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
