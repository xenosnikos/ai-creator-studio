import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { ok, readJson, route } from "@/lib/api";
import { config } from "@/lib/config";
import { secrets } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({
  target: z.enum(["anthropic", "kie", "elevenlabs"]),
  /** Test a key before saving it; omit to test the stored/env one. */
  apiKey: z.string().max(300).optional(),
});

export interface TestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

/**
 * Validate a key against the real service.
 *
 * Both probes are chosen to cost nothing: listing models on Anthropic, and a
 * lookup for a non-existent task on KIE. We only care whether the credential is
 * accepted, so "not found" is a pass and "unauthorized" is a fail.
 */
export const POST = route(async (request: Request) => {
  const body = testSchema.parse(await readJson(request));
  const stored = secrets();

  const key =
    body.apiKey?.trim() ||
    (body.target === "anthropic"
      ? stored.anthropicApiKey
      : body.target === "elevenlabs"
        ? stored.elevenLabsApiKey
        : stored.kieApiKey);

  if (!key) {
    return ok<TestResult>({ ok: false, message: "No key to test — enter one first." });
  }

  if (body.target === "anthropic") return ok(await testAnthropic(key));
  if (body.target === "elevenlabs") return ok(await testElevenLabs(key));
  return ok(await testKie(key));
});

async function testAnthropic(apiKey: string): Promise<TestResult> {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    const page = await client.models.list({ limit: 1 });
    const model = page.data[0]?.id;
    return {
      ok: true,
      message: "Anthropic key works.",
      detail: model ? `Account can see models (e.g. ${model}).` : undefined,
    };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, message: "Anthropic rejected this key (401)." };
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, message: "Key is valid but lacks permission (403)." };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, message: "Could not reach the Anthropic API — check your network." };
    }
    return {
      ok: false,
      message: "Anthropic key test failed.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testKie(apiKey: string): Promise<TestResult> {
  const url = `${config.kie.baseUrl}/api/v1/jobs/recordInfo?taskId=connectivity-probe`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `KIE rejected this key (${response.status}).` };
    }

    let code: number | undefined;
    let msg: string | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: number; msg?: string };
      code = parsed.code;
      msg = parsed.msg;
    } catch {
      return {
        ok: false,
        message: "KIE returned an unexpected response.",
        detail: text.slice(0, 200),
      };
    }

    // KIE reports auth failures in the envelope, not only the HTTP status.
    if (code === 401 || code === 403) {
      return { ok: false, message: `KIE rejected this key: ${msg ?? code}` };
    }
    // Anything else (including "task not found") means the key was accepted.
    return {
      ok: true,
      message: "KIE key works.",
      detail: "Authenticated successfully against the jobs API.",
    };
  } catch (error) {
    return {
      ok: false,
      message: "Could not reach KIE — check your network.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Confirms the key can actually *render*, not merely that it authenticates.
 * A free-plan key passes auth and then refuses library voices at generation
 * time, so listing voices is the cheapest call that proves real access.
 */
async function testElevenLabs(key: string): Promise<TestResult> {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        message: `ElevenLabs rejected the key (HTTP ${response.status})`,
        detail: text.slice(0, 200),
      };
    }
    const body = (await response.json()) as {
      voices?: Array<{ category?: string }>;
    };
    const premade = (body.voices ?? []).filter((v) => v.category === "premade").length;
    return {
      ok: true,
      message: `Key works — ${body.voices?.length ?? 0} voices available (${premade} premade).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: "Could not reach ElevenLabs",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
