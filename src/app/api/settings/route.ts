import { z } from "zod";

import { ok, readJson, route } from "@/lib/api";
import { providers, saveSettings } from "@/lib/settings";
import { settingsSnapshot } from "@/lib/settings-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  // "" clears the stored value and falls back to the environment.
  anthropicApiKey: z.string().max(300).optional(),
  kieApiKey: z.string().max(300).optional(),
  elevenLabsApiKey: z.string().max(300).optional(),
  anthropicModel: z.string().max(80).optional(),
  imageProvider: z.string().max(40).optional(),
  videoProvider: z.string().max(40).optional(),
  voiceProvider: z.string().max(40).optional(),
  lipSyncProvider: z.string().max(40).optional(),
  llmProvider: z.string().max(40).optional(),
});

export const GET = route(async () => ok(settingsSnapshot()));

export const POST = route(async (request: Request) => {
  const patch = patchSchema.parse(await readJson(request));
  // Trim: pasted keys routinely carry a trailing newline or space.
  const cleaned: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value?.trim()]),
  );

  // Saving a key while the matching stage is still on mock almost always means
  // "I want real output now" — flip it rather than making them find a second
  // control. Explicit provider choices in the same request always win.
  const current = providers();
  if (cleaned.kieApiKey) {
    for (const stage of [
      "imageProvider",
      "videoProvider",
      "voiceProvider",
      "lipSyncProvider",
    ] as const) {
      const key = stage.replace("Provider", "") as "image" | "video" | "voice" | "lipSync";
      if (cleaned[stage] === undefined && current[key] === "mock") cleaned[stage] = "kie";
    }
  }
  if (cleaned.anthropicApiKey && cleaned.llmProvider === undefined && current.llm === "mock") {
    cleaned.llmProvider = "anthropic";
  }
  // An ElevenLabs key is only ever added to use it, and it is the working route
  // for voice — so it wins the stage outright rather than only promoting from mock.
  if (cleaned.elevenLabsApiKey && cleaned.voiceProvider === undefined) {
    cleaned.voiceProvider = "elevenlabs";
  }

  saveSettings(cleaned);
  return ok(settingsSnapshot());
});
