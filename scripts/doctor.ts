/**
 * Preflight check against the real APIs.
 *
 *   npm run doctor              # free checks only: keys valid, credit balance
 *   npm run doctor -- --generate  # also submits one tiny job per model (COSTS CREDITS)
 *
 * Answers the question "which parts of this actually work on my account?"
 *
 * Reading a failure: a `422` naming a parameter is our request and is fixable
 * here; a `500` / "internal error, please try again later" that consumes no
 * credits is the provider's, and no amount of local editing will move it.
 *
 * Keys are read from the app's own settings (Settings page or .env.local) and
 * are never printed: output carries masked hints only, so it is safe to paste
 * into a chat or an issue.
 */

import { config } from "@/lib/config";
import { createTask, pollTask } from "@/lib/providers/kie/client";
import { ffmpegAvailable } from "@/lib/media/ffmpeg";
import { mask, providers, secrets } from "@/lib/settings";
import { DEFAULT_VOICE } from "@/lib/types";

const GENERATE = process.argv.includes("--generate");

type Status = "ok" | "fail" | "skip";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
  checks.push({ name, status, detail });
  const icon = status === "ok" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Never let a key reach the output, even if a provider echoes it back.
  return redact(text).slice(0, 220);
}

/** Strip anything key-shaped out of provider error text before printing it. */
function redact(text: string): string {
  const { anthropicApiKey, kieApiKey } = secrets();
  let out = text;
  for (const key of [anthropicApiKey, kieApiKey]) {
    if (key && key.length >= 8) out = out.split(key).join("«redacted»");
  }
  return out.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "«redacted»");
}

// ---------------------------------------------------------------------------

async function checkAnthropic(): Promise<void> {
  console.log("\nAnthropic");
  const key = secrets().anthropicApiKey;
  if (!key) {
    record("API key present", "skip", "not configured — add it on the Settings page");
    return;
  }
  record("API key present", "ok", mask(key) ?? "");

  const model = providers().llm === "mock" ? config.anthropic.model : anthropicModelName();
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    const body = (await response.json()) as {
      error?: { message?: string; type?: string };
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (!response.ok) {
      record(`model "${model}"`, "fail", redact(body.error?.message ?? `HTTP ${response.status}`));
      return;
    }
    const said = body.content?.[0]?.text?.trim() ?? "";
    record(
      `model "${model}"`,
      "ok",
      `replied ${JSON.stringify(said)} (${body.usage?.input_tokens ?? "?"} in / ${
        body.usage?.output_tokens ?? "?"
      } out tokens)`,
    );
  } catch (error) {
    record(`model "${model}"`, "fail", reason(error));
  }
}

function anthropicModelName(): string {
  // Imported lazily to keep this script runnable even if settings are empty.
  const { anthropicModel } = require("@/lib/settings") as typeof import("@/lib/settings");
  return anthropicModel();
}

// ---------------------------------------------------------------------------

async function checkKie(): Promise<void> {
  console.log("\nKIE AI");
  const key = secrets().kieApiKey;
  if (!key) {
    record("API key present", "skip", "not configured — add it on the Settings page");
    return;
  }
  record("API key present", "ok", mask(key) ?? "");

  // Credit balance, if the account exposes it. Endpoint names vary by plan, so
  // treat every failure as "could not read" rather than as a broken key.
  for (const path of ["/api/v1/chat/credit", "/api/v1/common/credit"]) {
    try {
      const response = await fetch(`${config.kie.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { code?: number; data?: unknown };
      if (body.code === 200) {
        record("credit balance", "ok", String(JSON.stringify(body.data)).slice(0, 80));
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (!GENERATE) {
    record(
      "model ids",
      "skip",
      "re-run with --generate to verify them (submits one tiny job each, costs credits)",
    );
    return;
  }

  // Cheapest possible request per model. A wrong model id fails at submit,
  // which is exactly the signal we want — and costs nothing when it fails.
  const trials: Array<{ label: string; model: string; input: Record<string, unknown> }> = [
    {
      // One model covers every image the pipeline makes, so one trial proves
      // the whole image path — including that the id is valid and its schema
      // is the one the adapter sends.
      label: `images (${config.kie.models.image})`,
      model: config.kie.models.image,
      input: {
        prompt:
          "A single plain grey square centred on a white background, flat lighting, no texture",
        aspect_ratio: "1:1",
        resolution: "1K",
      },
    },
    {
      label: `voice (${config.kie.models.voiceTTS}, voice="${DEFAULT_VOICE.voiceId}")`,
      model: config.kie.models.voiceTTS,
      // Uses the configured default voice. Everything about this call's shape
      // is a correction to KIE's published docs — `dialogue` is an array (not
      // the documented string), `language_code: "auto"` is rejected despite
      // being the documented default, and `voice` is an ElevenLabs id (not the
      // name the playground picker shows). See docs/PROVIDERS.md.
      input: /text-to-dialogue/.test(config.kie.models.voiceTTS)
        ? { dialogue: [{ text: "Preflight check.", voice: DEFAULT_VOICE.voiceId }] }
        : { text: "Preflight check.", voice: DEFAULT_VOICE.voiceId },
    },
  ];

  const produced: Record<string, string> = {};

  for (const trial of trials) {
    try {
      const taskId = await createTask(trial.model, trial.input);
      const url = await waitForUrl(taskId);
      produced[trial.model] = url;
      record(trial.label, "ok", `task ${taskId.slice(0, 12)}… → ${url.slice(0, 60)}…`);
    } catch (error) {
      record(trial.label, "fail", reason(error));
    }
  }

  // Video needs a real keyframe URL, so it can only run if the image trial
  // produced one. Chaining like this also proves the render path end to end.
  const seedImage = produced[config.kie.models.image];
  let clipUrl: string | undefined;
  if (!seedImage) {
    record(`video (${config.kie.models.videoSpeech})`, "skip", "no test keyframe was produced");
  } else {
    try {
      const taskId = await createTask(config.kie.models.videoSpeech, {
        prompt: "A person stands still and speaks to the camera.",
        reference_image_urls: [seedImage],
        generate_audio: true,
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: 5,
      });
      clipUrl = await waitForUrl(taskId, 10 * 60 * 1000);
      record(`video (${config.kie.models.videoSpeech})`, "ok", `${clipUrl.slice(0, 60)}…`);
    } catch (error) {
      record(`video (${config.kie.models.videoSpeech})`, "fail", reason(error));
    }
  }

  // The one most likely to be wrong.
  const voiceUrl = produced[config.kie.models.voiceTTS];
  if (!clipUrl || !voiceUrl) {
    record(
      `lip sync (${config.kie.models.lipSync})`,
      "skip",
      "needs both a test clip and a test voice track",
    );
  } else {
    try {
      const taskId = await createTask(config.kie.models.lipSync, {
        mode: config.kie.models.lipSyncMode,
        video_url: clipUrl,
        audio_url: voiceUrl,
        separate_vocal: false,
        open_scenedet: config.kie.models.lipSyncMode === "basic",
        align_audio: true,
      });
      const url = await waitForUrl(taskId, 10 * 60 * 1000);
      record(`lip sync (${config.kie.models.lipSync})`, "ok", `${url.slice(0, 60)}…`);
    } catch (error) {
      record(
        `lip sync (${config.kie.models.lipSync})`,
        "fail",
        `${reason(error)} — set KIE_LIPSYNC_MODEL to an id on your plan; renders still complete without it`,
      );
    }
  }
}

async function waitForUrl(taskId: string, timeoutMs = 5 * 60 * 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pollTask(taskId);
    if (result.status === "succeeded") return result.urls[0];
    if (result.status === "failed") throw new Error(result.error ?? "task failed");
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
}

// ---------------------------------------------------------------------------

/**
 * Not optional — this is what turns a set of shots into the video that was
 * asked for. Without it a 30-second brief hands back four files, each ending on
 * the dead air the trim would have removed. Reported up front alongside the API
 * keys, because the alternative is discovering it after a paid render.
 */
async function checkFfmpeg(): Promise<void> {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (await ffmpegAvailable()) {
    record("ffmpeg", "ok", configured ? `FFMPEG_PATH=${configured}` : "found on PATH");
    return;
  }
  record(
    "ffmpeg",
    "fail",
    "not found — the shots cannot be joined, so a multi-shot video comes back as separate " +
      "clips, and the silence at the end of each one cannot be trimmed. " +
      // Named because this is how it actually goes missing. `ffmpeg-static` ships
      // the binary via an install script, and an npm that blocks install scripts
      // installs the package without it — printing a warning at the top of a long
      // install log that nobody reads, then failing much later and elsewhere.
      "It ships with the app via ffmpeg-static, so the usual cause is npm declining to run " +
      "install scripts: check `npm install` output for an 'allow-scripts' warning naming " +
      "ffmpeg-static, then run `npm approve-scripts ffmpeg-static` and `npm install` again. " +
      "Otherwise install ffmpeg yourself and set FFMPEG_PATH to it.",
  );
}

async function main(): Promise<void> {
  console.log("AI Creator Studio — preflight check");
  console.log(GENERATE ? "Mode: full (submits real jobs, spends credits)" : "Mode: free checks only");

  const selected = providers();
  console.log(
    `\nActive providers: llm=${selected.llm} image=${selected.image} video=${selected.video} voice=${selected.voice} lipSync=${selected.lipSync}`,
  );

  await checkAnthropic();
  await checkKie();
  await checkFfmpeg();

  const failed = checks.filter((c) => c.status === "fail");
  const skipped = checks.filter((c) => c.status === "skip");
  console.log(
    `\n${checks.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
  );
  if (failed.length > 0) {
    console.log("\nFailures worth acting on:");
    for (const check of failed) console.log(`  · ${check.name}: ${check.detail}`);
  }
  console.log("\nNo API keys appear anywhere in this output — it is safe to share.\n");
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(reason(error));
  process.exit(1);
});
