import { createHash } from "node:crypto";

import type { Scene } from "@/lib/types";

type FingerprintScene = Pick<Scene, "spec" | "dialogue" | "durationSeconds">;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

/** Inputs that determine what the preview still depicts. */
export function visualFingerprint(scene: FingerprintScene): string {
  return digest({ spec: scene.spec });
}

/** Inputs that determine the words and delivery of a scene's voice take. */
export function voiceFingerprint(scene: FingerprintScene): string {
  return digest({ dialogue: scene.dialogue, spec: scene.spec });
}

/** Inputs that determine the animated performance and its planned length. */
export function videoFingerprint(scene: FingerprintScene): string {
  return digest({
    visual: visualFingerprint(scene),
    voice: voiceFingerprint(scene),
    durationSeconds: scene.durationSeconds,
  });
}
