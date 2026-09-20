import { rename, rm } from "node:fs/promises";

import { audioDuration, type AudioDuration } from "@/lib/media/duration";
import { compressAudio } from "@/lib/media/ffmpeg";
import { deliveryTagFor } from "@/lib/prompting";
import { voiceProvider } from "@/lib/providers/registry";
import type { AwaitOptions } from "@/lib/jobs/runner";
import type { TaskHandle, TaskResult } from "@/lib/providers/types";
import { assets, projects } from "@/lib/repo";
import { absoluteAssetPath, persistFromUrl, readAsset } from "@/lib/storage";
import { voiceFingerprint } from "@/lib/scene-fingerprint";
import type { Asset, Scene } from "@/lib/types";

/**
 * Voice synthesis, extracted so both the standalone voice stage and the video
 * stage can call it.
 *
 * The video stage needs it because a clip's length is decided by how long the
 * narration actually takes to say — so the audio has to exist first. Sharing
 * one function means "render voice" and "render video" cannot drift into
 * producing subtly different takes of the same line.
 */

export interface SynthesizedVoice {
  asset: Asset;
  duration: AudioDuration;
}

/**
 * Generate this scene's line in the creator's locked voice.
 *
 * Adjacent scene dialogue is passed as prosody context, which is what stops
 * each clip from sounding like a fresh, disconnected take — the requirement is
 * consistent cadence and tone across the whole piece, not just the same timbre.
 */
export async function synthesizeSceneVoice(input: {
  scene: Scene;
  projectId: string;
  creatorId: string;
  voice: import("@/lib/types").VoiceConfig;
  awaitTask: (
    handle: TaskHandle,
    poll: (handle: TaskHandle) => Promise<TaskResult>,
    options?: AwaitOptions,
  ) => Promise<TaskResult>;
  progressFloor?: number;
  progressCeiling?: number;
  /**
   * The longest this take may be, if the caller knows. A recording longer than
   * the shot it plays under forces the lip-sync model to stretch the picture,
   * which slides the mouth out of step for the rest of the clip.
   */
  fitSeconds?: number;
}): Promise<SynthesizedVoice> {
  const { scene, projectId, creatorId, voice } = input;

  const siblings = projects.scenes(projectId);
  const position = siblings.findIndex((s) => s.id === scene.id);
  const previousText = position > 0 ? siblings[position - 1].dialogue : undefined;
  const nextText =
    position >= 0 && position < siblings.length - 1 ? siblings[position + 1].dialogue : undefined;

  const provider = voiceProvider();
  const submit = () =>
    provider.submit({
      text: scene.dialogue,
      voice,
      previousText: previousText || undefined,
      nextText: nextText || undefined,
      // Ties the read to the shot's mood, so a project does not come back in
      // one flat register from end to end.
      delivery: deliveryTagFor(scene.spec),
    });
  const result = await input.awaitTask(await submit(), (h) => provider.poll(h), {
    resubmit: submit,
    progressFloor: input.progressFloor,
    progressCeiling: input.progressCeiling ?? 90,
  });

  const url = result.urls[0];
  const stored = await persistFromUrl(
    url,
    `projects/${projectId}`,
    `scene-${scene.index + 1}-${creatorId}-vo-${Date.now()}`,
  );

  // Measure from the bytes we just wrote rather than re-downloading.
  let duration = audioDuration(await readAsset(stored.relativePath), scene.dialogue);

  /**
   * Make the take fit the shot.
   *
   * Needed even when the line was written to length, because the model's pacing
   * is not deterministic: the same sentence in the same voice came back at
   * 7.39s, 7.08s and 7.31s across three runs. So a few percent of overrun is
   * normal and cannot be planned away, and a few percent is exactly what this
   * absorbs — inaudibly, and without touching the words.
   *
   * A large overrun is a different thing and is deliberately not papered over.
   * That means the line is too long for the shot, the compressor declines, and
   * the scene card says so.
   */
  const fit = input.fitSeconds;
  let speedup: number | null = null;
  if (fit && fit > 0 && duration.seconds > fit) {
    const original = absoluteAssetPath(stored.relativePath);
    // ffmpeg cannot read and write the same file in one pass — it truncates the
    // input before it has finished reading it. Encode beside it, then swap.
    const scratch = `${original}.fit.mp3`;
    try {
      const compressed = await compressAudio(original, scratch, duration.seconds / fit);
      if (compressed) {
        await rename(scratch, original);
        speedup = round(duration.seconds / fit);
        duration = { seconds: compressed.seconds, source: duration.source };
      }
    } finally {
      await rm(scratch, { force: true });
    }
  }

  const asset = assets.create({
    kind: "audio",
    projectId,
    sceneId: scene.id,
    creatorId,
    remoteUrl: url,
    localPath: stored.relativePath,
    prompt: scene.dialogue,
    meta: {
      provider: provider.name,
      voiceId: voice.voiceId,
      voiceLabel: voice.label,
      stability: voice.stability,
      similarityBoost: voice.similarityBoost,
      style: voice.style,
      speed: voice.speed,
      delivery: deliveryTagFor(scene.spec),
      durationSeconds: round(duration.seconds),
      durationSource: duration.source,
      // Recorded so the scene card can say the take was tightened rather than
      // leaving a silently faster read to be discovered by ear.
      ...(speedup ? { speedup } : {}),
      voiceFingerprint: voiceFingerprint(scene),
    },
  });

  return { asset, duration };
}

/** Duration of an already-generated voice asset, measured from its local file. */
export async function measureVoiceAsset(
  asset: Asset,
  fallbackText: string,
): Promise<AudioDuration> {
  const recorded = asset.meta.durationSeconds;
  const source = asset.meta.durationSource;
  if (typeof recorded === "number" && recorded > 0 && typeof source === "string") {
    return { seconds: recorded, source: source as AudioDuration["source"] };
  }
  if (!asset.localPath) return audioDuration(Buffer.alloc(0), fallbackText);
  try {
    return audioDuration(await readAsset(asset.localPath), fallbackText);
  } catch {
    return audioDuration(Buffer.alloc(0), fallbackText);
  }
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
