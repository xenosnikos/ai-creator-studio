import { config } from "@/lib/config";
import { createTask, pollTask, uploadBase64 } from "@/lib/providers/kie/client";
import {
  ProviderError,
  type ImageProvider,
  type ImageRequest,
  type TaskHandle,
  type TaskResult,
} from "@/lib/providers/types";

/**
 * The image path on KIE. One model, every render.
 *
 * It used to be two: one family for creator portraits and identity sheets,
 * another for scenes and location plates, routed by what the render was for.
 * A like-for-like test ended that — identical compiled prompt, identical
 * reference image, one render each — and the creator model won on the scene
 * as well, by a wide margin. The other family produced the centred, glossy,
 * posed-at-the-lens frame that reads as generated on sight, which is the one
 * thing this pipeline exists to avoid.
 *
 * Keeping the loser configurable was not free: two families do not share an
 * input schema, so the adapter carried a branch, the request carried a
 * `purpose` flag, and every stage had to remember to set it. Sending the wrong
 * shape returns `500: This field is required` without naming the field. One
 * model means one schema and none of that.
 *
 * Passing reference images is what selects image-to-image; the same model id
 * covers both directions.
 */

/** The model's documented reference cap. */
const MAX_REFERENCES = 8;

/**
 * The model's prompt ceiling.
 *
 * 5000, stated by the API itself: over it, generation fails with "Your prompt
 * cannot exceed 5000 characters". Not a submit-time rejection — `createTask`
 * returns a task id and the request is only refused when it runs, which is why
 * a probe that submitted 20000 characters and read the 200 back concluded there
 * was no limit worth worrying about. Checking submission proves nothing here;
 * the task has to be polled to a terminal state.
 *
 * The compiler budgets below this and squeezes its authored fields to fit. What
 * it must never do is exceed it, because for a long time the adapter trimmed
 * silently instead: every scene prompt compiled to ~8700 characters and arrived
 * as 5000, losing the skin statement, the entire AVOID list and the consistency
 * key on every render. That is why the same creator came back with green eyes
 * in one shot and brown in the next, and why two attempts at fixing blemishes
 * changed text that was never being sent.
 */
const MODEL_PROMPT_CHARS = 5000;

export class KieImageProvider implements ImageProvider {
  readonly name = "kie";
  readonly acceptsVectorReferences = false;

  async submit(request: ImageRequest): Promise<TaskHandle> {
    // Refuse rather than trim. A prompt this long means the compiler's budget
    // has drifted above the model's ceiling, and the failure mode of trimming
    // is silent: the render succeeds, looks fine, and quietly lost whichever
    // instructions came last. An error naming both numbers is recoverable; a
    // creator whose face changes between shots is not.
    if (request.prompt.length > MODEL_PROMPT_CHARS) {
      throw new ProviderError(
        `Prompt is ${request.prompt.length} characters, over this model's ${MODEL_PROMPT_CHARS} ceiling. ` +
          `Lower IMAGE_PROMPT_LIMIT in src/lib/prompting.ts — trimming here would silently drop ` +
          `the identity constraints that keep a creator consistent between shots.`,
        this.name,
      );
    }

    const taskId = await createTask(config.kie.models.image, primaryInput(request));
    return { taskId, provider: this.name };
  }

  /**
   * Submit the same render to the fallback model.
   *
   * Returns null when there is nothing to fall back to, or when the request
   * carries no reference images — the fallback is an editing model and cannot
   * work from a prompt alone.
   *
   * The prompt and the references are passed through unchanged. The point is
   * to ask a different vendor, not to ask the same one differently.
   */
  async submitAlternate(request: ImageRequest): Promise<TaskHandle | null> {
    const model = config.kie.models.imageFallback;
    if (!model || model === config.kie.models.image) return null;
    if (request.referenceUrls.length === 0) return null;

    const taskId = await createTask(model, alternateInput(model, request));
    return { taskId, provider: this.name };
  }

  poll(handle: TaskHandle): Promise<TaskResult> {
    return pollTask(handle.taskId);
  }

  uploadImage(bytes: Buffer, fileName: string): Promise<string> {
    return uploadBase64(bytes, fileName, "images/creator-refs");
  }
}

/** The primary model's payload. */
function primaryInput(request: ImageRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    // A resolution tier, not a quality name. `high` is 4K: more pixels on
    // the face is the whole game for identity, and a keyframe is also an
    // exportable still in its own right. The video model downsamples to
    // 720p, so the extra detail buys nothing for the clip specifically —
    // it buys a usable photograph.
    resolution: request.quality === "high" ? "4K" : "1K",
    output_format: request.outputFormat ?? "png",
  };

  if (request.referenceUrls.length > 0) {
    // Order matters: identity anchors are passed first so they dominate the
    // conditioning over wardrobe, location and style references.
    input.image_input = request.referenceUrls.slice(0, MAX_REFERENCES);
  }
  return input;
}

/**
 * The fallback model takes a named size rather than a ratio. Values verified
 * against the live API, which validates this field at submission — an invalid
 * one comes back `500 This image_size is not within the range of allowed
 * options` rather than failing later during generation.
 */
const IMAGE_SIZES: Record<string, string> = {
  "9:16": "portrait_16_9",
  "3:4": "portrait_4_3",
  "4:5": "portrait_4_3",
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "4:3": "landscape_4_3",
};

/**
 * The fallback model's payload, which is not one shape.
 *
 * The two editing models that have been used here disagree about how to ask
 * for the same two things. `seedream/4.5-edit` takes a plain `aspect_ratio`
 * and a `quality` tier; `bytedance/seedream-v4-edit` takes a named
 * `image_size` and a separate `image_resolution`. Sending one model the
 * other's fields is not an error it reports — unknown fields come back 200 and
 * are ignored, so the request quietly falls back to defaults and returns a
 * 1080p image with the right aspect ratio and a fifth of the pixels. Branching
 * on the id is what keeps 4K actually 4K.
 */
function alternateInput(model: string, request: ImageRequest): Record<string, unknown> {
  const images = request.referenceUrls.slice(0, MAX_REFERENCES);

  if (/^seedream\//.test(model)) {
    return {
      prompt: request.prompt,
      image_urls: images,
      aspect_ratio: ALTERNATE_RATIOS[request.aspectRatio] ?? "9:16",
      /**
       * The tier this maps to differs by model — `high` is 4K on the 4.5
       * editor and 2K on the 5-pro one — so this asks for the model's best
       * rather than for a specific pixel count.
       */
      quality: request.quality === "high" ? "high" : "basic",
      output_format: request.outputFormat ?? "png",
      nsfw_checker: config.kie.nsfwChecker,
    };
  }

  return {
    prompt: request.prompt,
    image_urls: images,
    image_size: IMAGE_SIZES[request.aspectRatio] ?? "portrait_16_9",
    image_resolution: request.quality === "high" ? "4K" : "1K",
  };
}

/**
 * Ratios the 4.5 editor accepts. `4:5` is not among them, so it maps to the
 * nearest portrait it does take rather than being sent through and ignored.
 */
const ALTERNATE_RATIOS: Record<string, string> = {
  "9:16": "9:16",
  "3:4": "3:4",
  "4:5": "3:4",
  "1:1": "1:1",
  "16:9": "16:9",
  "4:3": "4:3",
};
