import { config } from "@/lib/config";
import { createTask, pollTask, truncate } from "@/lib/providers/kie/client";
import type {
  TaskHandle,
  TaskResult,
  VideoProvider,
  VideoRequest,
} from "@/lib/providers/types";

/**
 * Seedance 2.0 (fast) on KIE — the talking-head path.
 *
 * The important difference from an image-to-video model: this one takes the
 * voice track as a *reference* and generates motion that is already speaking
 * it. There is no lip-sync repair pass, because there is nothing to repair.
 *
 * Measured against the animate-then-repair route on the same keyframe and the same
 * voice: that route produced a fixed smile for the whole clip (no jaw movement
 * at all across 2.4s of continuous speech), while this one produces real
 * phoneme-level articulation and a transcript that matches the script word for
 * word. Lip sync as a post-process has to detect, crop, regenerate and
 * composite a face the video model already committed to; on a moving or
 * grinning subject it degrades to a no-op.
 *
 * Two behaviours worth knowing:
 *
 * 1. The reference audio is a reference, not a soundtrack. Seedance re-performs
 *    the line rather than muxing the file — the words and the timbre carry over
 *    (verified: identical transcript, median F0 within 5% of the source), but
 *    the timing is its own. If a scene needs the exact ElevenLabs waveform,
 *    mark it `speechMode: "voiceover"`: the shot is rendered non-speaking and
 *    the recording is overlaid unchanged. (`mux` on an on-camera line is
 *    refused before rendering — the overlaid mouth cannot match.)
 * 2. `duration` should track the narration closely. Any second of clip beyond
 *    the end of the speech is a second the model fills with invented motion,
 *    which is where end-of-clip drift comes from.
 */

const MAX_PROMPT_CHARS = 20000;

/**
 * The model's top tier. Probed against the live API: `480p` and `720p` are
 * accepted, `1080p` and `2160p` come back `422 Invalid resolution`. Sent as a
 * constant rather than from the request because there is nothing to choose
 * between — the project setting exists to be reported, not to be varied.
 */
const MAX_RESOLUTION = "720p" as const;

/**
 * Usable bounds for a `reference_audio_urls` entry.
 *
 * The provider's own error names 1.8s as the floor; 2 keeps a margin. These
 * were previously exported and never referenced by anything, so the limit went
 * unenforced and a short line failed the render with a message about audio
 * duration that nothing in the pipeline was watching for.
 */
const AUDIO_REFERENCE_SECONDS = { min: 2, max: 15 } as const;

export class KieSeedanceVideoProvider implements VideoProvider {
  readonly name = "kie:seedance";
  readonly voiceReferenceSeconds = AUDIO_REFERENCE_SECONDS;
  readonly minClipSeconds = 4;
  readonly maxClipSeconds = 15;
  readonly speaksFromVoice = true;

  async submit(request: VideoRequest): Promise<TaskHandle> {
    if (request.imageUrls.length === 0) {
      throw new Error("Seedance requires a keyframe image URL");
    }

    /**
     * When the keyframe can only be sent as a reference, say in words what the
     * field can no longer say structurally.
     *
     * `reference_image_urls` means "this is a reference" to the model, and it
     * treats it as one: it renders a scene that resembles the still instead of
     * starting from it. Measured, that costs about 10 points of RMSE against
     * the approved frame. The voice reference forces this path on every
     * speaking shot, so the instruction moves into the prompt, where it is the
     * only lever left.
     *
     * Written as a description of the first frame rather than as a rule about
     * an image, because that is what the model is being asked to produce. It
     * goes first, ahead of the scene direction: the opening frame is a
     * condition on everything that follows, not a note at the end.
     */
    const openOnKeyframe = request.voiceUrl
      ? "THE FIRST FRAME OF THIS VIDEO IS THE ATTACHED REFERENCE IMAGE. Frame one is that " +
        "photograph, unchanged: the same person, the same face and hair, the same clothing, the " +
        "same room with the same walls, furniture, objects and their exact positions, the same " +
        "light and the same colour, shot from the same camera position and distance at the same " +
        "framing. Do not re-imagine the place, redecorate it, move anything in it, change the " +
        "outfit or re-frame the shot. Begin exactly there and only then let the motion described " +
        "below happen, keeping every one of those things the same all the way through.\n\n"
      : "";

    const input: Record<string, unknown> = {
      prompt: truncate(`${openOnKeyframe}${request.prompt}`, MAX_PROMPT_CHARS),
      /**
       * The keyframe, sent one of two ways, and the model decides which.
       *
       * `first_frame_url` is by far the better of the two. Measured over three
       * renders each way from one approved still, comparing frame 0 of the
       * finished clip against the still that was sent:
       *
       *   first_frame_url        the same picture, cropped 2% at the centre;
       *                          RMSE 9.1–9.7 once that crop is undone
       *   reference_image_urls   RMSE 19.0–20.8, and no crop factor improves
       *                          it — a similar scene, painted fresh
       *
       * against an encoding floor of 2.7 for the identical image re-encoded.
       * One reproduces the approved frame; the other renders something that
       * resembles it, which is where "I approved that still and the clip is in
       * a different room" comes from.
       *
       * (If this is ever re-measured: search for the crop. Comparing whole
       * frames without it ranks `first_frame_url` *worse*, 23.6 against 22.1,
       * because a 2% offset misaligns every edge in the picture. The more
       * faithful result scores worse on the cruder measure.)
       *
       * So why is it conditional? Because the model will not accept a first
       * frame and a voice reference in the same request. It takes the payload,
       * returns a task id, and then fails the task with `The parameter content
       * specified in the request is not valid: first/last frame content cannot
       * be mixed with reference media content`. Submission is not acceptance
       * here — the conflict only appears at render time, which is after the
       * queue has moved on and looks like an unrelated failure.
       *
       * The voice reference wins that tie, and not narrowly. It is what makes
       * the model perform the line, and the alternative — animate the keyframe,
       * then repair the mouth — was measured on this same pipeline producing a
       * fixed smile across 2.4s of continuous speech. A clip in a slightly
       * reinterpreted kitchen is a blemish; a talking head whose mouth does not
       * move is unusable. Silent shots have nothing to trade, so they get the
       * exact frame.
       *
       * Four undocumented spellings of an audio input (`audio_url`,
       * `audio_urls`, `speech_url`, `voice_url`) were tried against a first
       * frame and all four returned a finished video — which proves nothing on
       * this API, where an unknown field is accepted and ignored, and the model
       * invents a soundtrack when told to generate audio. They are not used.
       */
      ...(request.voiceUrl
        ? { reference_image_urls: request.imageUrls.slice(0, 9) }
        : { first_frame_url: request.imageUrls[0] }),
      /**
       * Only ask for sound when there is a voice track to drive it.
       *
       * With `generate_audio: true` and no `reference_audio_urls`, the model
       * has to invent a soundtrack from nothing — and the provider refuses
       * that outright with `Your credit balance is too low. Please top up.`,
       * an error that has nothing to do with the actual cause and sent a long
       * investigation at the account instead of the payload. Verified all
       * three ways against a live key: true + reference succeeds, true alone
       * fails, false alone succeeds.
       *
       * So every silent B-roll shot used to fail, as did any speaking shot
       * whose voice job had failed upstream.
       */
      generate_audio: Boolean(request.voiceUrl),
      resolution: MAX_RESOLUTION,
      aspect_ratio: request.aspectRatio,
      duration: clampDuration(request.durationSeconds, this.minClipSeconds, this.maxClipSeconds),
      /**
       * Always present in the payload, and off by default.
       *
       * Unverified on this model, unlike on the image ones: they reject a bad
       * value for this field, whereas this model accepts `nsfw_checker:
       * "bogus"` with a 200 — which is how this API behaves for parameters it
       * does not know. So it is either honoured or ignored, and the request
       * alone cannot tell which. Sent regardless: it costs nothing if ignored
       * and matters if not. Noted here so the line is not later mistaken for
       * proof the filter is off.
       */
      nsfw_checker: config.kie.nsfwChecker,
    };

    // Reference audio may not be the only reference — it is always paired with
    // the keyframe above, so this is safe to add unconditionally.
    if (request.voiceUrl) input.reference_audio_urls = [request.voiceUrl];

    const taskId = await createTask(config.kie.models.videoSpeech, input);
    return { taskId, provider: this.name };
  }

  poll(handle: TaskHandle): Promise<TaskResult> {
    return pollTask(handle.taskId);
  }
}

function clampDuration(seconds: number, min: number, max: number): number {
  if (!Number.isFinite(seconds)) return min;
  return Math.max(min, Math.min(max, Math.round(seconds)));
}

