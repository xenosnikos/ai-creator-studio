import { createHash } from "node:crypto";

import type { Scene, SceneSpec } from "@/lib/types";

type FingerprintScene = Pick<Scene, "spec" | "dialogue" | "durationSeconds">;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

/**
 * The spec as it was serialised before `speechMode` existed.
 *
 * Speech mode decides how the clip is *performed*; it changes nothing about
 * what the still depicts or what the voice says. So it is removed before the
 * still and voice hashes are taken — otherwise flipping a scene to voice-over
 * would throw away an approved keyframe and a paid voice take that are both
 * still exactly right. Removing the key (rather than defaulting it) also keeps
 * every hash written before the field existed byte-identical.
 */
function legacySpec(spec: SceneSpec): Omit<SceneSpec, "speechMode"> {
  if (!("speechMode" in spec)) return spec;
  const { speechMode: _speechMode, ...rest } = spec;
  return rest;
}

/** Inputs that determine what the preview still depicts. */
export function visualFingerprint(scene: FingerprintScene): string {
  return digest({ spec: legacySpec(scene.spec) });
}

/** Inputs that determine the words and delivery of a scene's voice take. */
export function voiceFingerprint(scene: FingerprintScene): string {
  return digest({ dialogue: scene.dialogue, spec: legacySpec(scene.spec) });
}

/**
 * Inputs that determine the animated performance and its planned length.
 *
 * Speech mode joins the hash only when it is `voiceover`: a speaking clip and a
 * non-speaking one are different renders, so switching invalidates the clip.
 * `on_camera` and unset both mean the legacy speaking render and hash exactly
 * as they did before, so no existing clip is invalidated by the field merely
 * existing.
 */
export function videoFingerprint(scene: FingerprintScene): string {
  const base = {
    visual: visualFingerprint(scene),
    voice: voiceFingerprint(scene),
    durationSeconds: scene.durationSeconds,
  };
  return digest(scene.spec.speechMode === "voiceover" ? { ...base, speechMode: "voiceover" } : base);
}
