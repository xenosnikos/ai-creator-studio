import Anthropic from "@anthropic-ai/sdk";

import { ProviderError, type LLMJsonRequest, type LLMProvider } from "@/lib/providers/types";
import { anthropicModel, secrets } from "@/lib/settings";

/**
 * Claude, used for every reasoning task in the app: reading a creator's
 * reference photos into a locked identity block, turning a one-line brief into
 * a scene-by-scene storyboard, writing the narration script, and compiling
 * scene specs into model-ready prompts.
 *
 * All calls are structured: the response is constrained to a JSON Schema and
 * validated before it reaches the domain layer, so a malformed generation
 * fails loudly at the boundary rather than corrupting a project.
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic | null = null;
  private keyInUse: string | null = null;

  private getClient(): Anthropic {
    const apiKey = secrets().anthropicApiKey;
    if (!apiKey) {
      throw new ProviderError(
        "No Anthropic API key configured. Add one on the Settings page, or set ANTHROPIC_API_KEY in .env.local. To run without keys, switch the reasoning provider to Mock.",
        "anthropic",
      );
    }
    // Rebuild if the key changed under us (e.g. saved on the Settings page).
    if (!this.client || this.keyInUse !== apiKey) {
      this.client = new Anthropic({ apiKey });
      this.keyInUse = apiKey;
    }
    return this.client;
  }

  async json<T>(request: LLMJsonRequest<T>): Promise<T> {
    // One retry: structured outputs make malformed JSON rare, but a schema the
    // model half-satisfies (e.g. too few scenes) still fails our validator.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.complete(request, attempt);
        return request.parse(JSON.parse(text));
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError) throw error;
      }
    }
    throw new ProviderError(
      `Claude did not return a valid response after 2 attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      "anthropic",
      undefined,
      lastError,
    );
  }

  private async complete<T>(request: LLMJsonRequest<T>, attempt: number): Promise<string> {
    const client = this.getClient();

    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of request.images ?? []) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: image.data,
        },
      });
    }
    content.push({
      type: "text",
      text:
        attempt === 0
          ? request.user
          : `${request.user}\n\nYour previous response did not satisfy the required schema. Return only valid JSON matching it exactly.`,
    });

    // Streamed because storyboards and scripts run long and non-streaming
    // requests with a large max_tokens risk an HTTP timeout.
    const stream = client.messages.stream({
      model: anthropicModel(),
      max_tokens: request.maxTokens ?? 32000,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      output_config: {
        format: { type: "json_schema", schema: sanitizeSchema(request.schema) },
      },
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new ProviderError(
        "Claude declined this request. Try rephrasing the creative brief.",
        "anthropic",
        undefined,
        message.stop_details,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError(
        "Claude's response was truncated before it finished. Try a shorter brief or fewer scenes.",
        "anthropic",
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (!text.trim()) {
      throw new ProviderError("Claude returned an empty response", "anthropic");
    }
    return text;
  }
}

/**
 * Structured outputs accept a subset of JSON Schema, and reject the whole
 * request — not just the offending keyword — when given something outside it.
 * `maxItems` is the one that bites here.
 *
 * Stripping rather than never writing them keeps the schemas honest as
 * documentation, and costs nothing at runtime: every response is validated
 * against the real Zod parser afterwards, which enforces the same bounds
 * properly. Doing it here means a schema edit can never break live generation
 * while passing in mock mode.
 */
const UNSUPPORTED_KEYWORDS = new Set(["maxItems", "uniqueItems", "minContains", "maxContains"]);

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strip(schema) as Record<string, unknown>;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, entry]) => [key, strip(entry)]),
  );
}
