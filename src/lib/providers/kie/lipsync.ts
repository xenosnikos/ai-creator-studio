import { config } from "@/lib/config";
import { createTask, pollTask } from "@/lib/providers/kie/client";
import type {
  LipSyncProvider,
  LipSyncRequest,
  TaskHandle,
  TaskResult,
} from "@/lib/providers/types";

/**
 * Volcengine video-to-video lip sync on KIE.
 *
 * Model id and schema verified against a live account. Both inputs must be URLs
 * the provider can fetch, which is why the caller passes remote URLs rather
 * than local paths.
 */
export class KieLipSyncProvider implements LipSyncProvider {
  readonly name = "kie:lipsync";

  async submit(request: LipSyncRequest): Promise<TaskHandle> {
    const taskId = await createTask(config.kie.models.lipSync, {
      mode: config.kie.models.lipSyncMode,
      video_url: request.videoUrl,
      audio_url: request.audioUrl,
      /**
       * The audio we send is a clean TTS render with no background bed, so
       * running vocal separation over it would only risk artefacts on a signal
       * that is already isolated.
       */
      separate_vocal: false,
      /**
       * Scene detection + speaker identification. Only honoured in `basic`
       * mode, and the reason `basic` is the default: it keeps the mouth on the
       * right face across a cut.
       */
      open_scenedet: config.kie.models.lipSyncMode === "basic",
      /**
       * Loop the picture if the narration outlasts it. The clip is already cut
       * to the measured length of this exact audio, so this should never fire —
       * it is here so that when a line does overrun, the result is a slightly
       * extended shot rather than speech continuing over a frozen last frame.
       */
      align_audio: true,
      align_audio_reverse: false,
    });
    return { taskId, provider: this.name };
  }

  poll(handle: TaskHandle): Promise<TaskResult> {
    return pollTask(handle.taskId);
  }
}
