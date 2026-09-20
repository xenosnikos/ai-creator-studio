import { config } from "@/lib/config";
import { availableProviders } from "@/lib/providers/registry";
import { anthropicModel, mask, providers, secrets, sourceOf } from "@/lib/settings";

export interface KeyState {
  configured: boolean;
  hint: string | null;
  source: "settings" | "env" | "default";
}

/**
 * What the Settings page is allowed to know.
 *
 * Deliberately carries no model identifiers. Which models sit behind each stage
 * is an implementation detail of this product, and anything placed here is
 * shipped to the browser and readable in the page source — so the way to keep
 * it private is to not send it, not to hide it in the markup.
 */
export interface SettingsSnapshot {
  keys: { anthropic: KeyState; kie: KeyState; elevenLabs: KeyState };
  providers: { image: string; video: string; voice: string; lipSync: string; llm: string };
  available: {
    image: string[];
    video: string[];
    voice: string[];
    lipSync: string[];
    llm: string[];
  };
  storagePath: string;
}

/**
 * Current configuration.
 *
 * Secrets are never returned in full — only a masked hint, a boolean, and where
 * the value came from, which is enough to make the UI unambiguous without ever
 * putting a usable key on the wire.
 *
 * Lives here rather than in the route handler because the Settings page renders
 * it on the server too: the page must show real values in its first paint, not
 * a spinner that depends on a browser fetch succeeding.
 */
export function settingsSnapshot(): SettingsSnapshot {
  const { anthropicApiKey, kieApiKey, elevenLabsApiKey } = secrets();

  const selected = providers();
  return {
    keys: {
      anthropic: {
        configured: Boolean(anthropicApiKey),
        hint: mask(anthropicApiKey),
        source: sourceOf("anthropicApiKey"),
      },
      kie: {
        configured: Boolean(kieApiKey),
        hint: mask(kieApiKey),
        source: sourceOf("kieApiKey"),
      },
      elevenLabs: {
        configured: Boolean(elevenLabsApiKey),
        hint: mask(elevenLabsApiKey),
        source: sourceOf("elevenLabsApiKey"),
      },
    },
    providers: selected,
    available: availableProviders(),
    // Where settings.json lives, so the operator knows what to protect/delete.
    storagePath: `${config.dataDir}/settings.json`,
  };
}
