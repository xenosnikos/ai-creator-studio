import { ok, route } from "@/lib/api";
import { config } from "@/lib/config";
import { anthropicModel, providers, secrets } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configuration snapshot. The UI shows this so a reviewer can tell at a glance
 * whether they are looking at real generations or offline placeholders, and
 * which models produced them.
 */
export const GET = route(async () => {
  const { anthropicApiKey, kieApiKey, elevenLabsApiKey } = secrets();
  const selected = providers();

  const ready = (kind: keyof typeof selected) => {
    if (selected[kind] === "mock") return true;
    // Each stage is ready when *its own* credential is present. Voice used to
    // be judged by the KIE key, so an ElevenLabs-only setup reported voice as
    // not ready while it worked, and a KIE-only setup reported it ready right
    // up until the render failed for want of an ElevenLabs key.
    if (kind === "llm") return Boolean(anthropicApiKey);
    if (kind === "voice") {
      return selected.voice === "elevenlabs" ? Boolean(elevenLabsApiKey) : Boolean(kieApiKey);
    }
    return Boolean(kieApiKey);
  };

  return ok({
    providers: {
      image: { provider: selected.image, ready: ready("image") },
      video: { provider: selected.video, ready: ready("video") },
      voice: { provider: selected.voice, ready: ready("voice") },
      llm: { provider: selected.llm, ready: ready("llm") },
    },
  });
});
