import { AnthropicLLMProvider } from "@/lib/providers/anthropic/llm";
import { ElevenLabsVoiceProvider } from "@/lib/providers/elevenlabs/voice";
import { KieImageProvider } from "@/lib/providers/kie/image";
import { KieLipSyncProvider } from "@/lib/providers/kie/lipsync";
import { KieSeedanceVideoProvider } from "@/lib/providers/kie/seedance";
import { KieVoiceProvider } from "@/lib/providers/kie/voice";
import { MockLLMProvider } from "@/lib/providers/mock/llm";
import {
  MockImageProvider,
  MockLipSyncProvider,
  MockVideoProvider,
  MockVoiceProvider,
} from "@/lib/providers/mock/media";
import type {
  ImageProvider,
  LipSyncProvider,
  LLMProvider,
  VideoProvider,
  VoiceProvider,
} from "@/lib/providers/types";
import { providers as selectedProviders } from "@/lib/settings";

/**
 * Single place where provider names resolve to implementations.
 *
 * Adding a vendor is two steps: write an adapter that satisfies the interface,
 * then add a case here. Nothing else in the codebase names a vendor.
 */

const imageProviders: Record<string, () => ImageProvider> = {
  // One image path. The key never names a model: which model backs a stage is
  // not something the UI discloses.
  kie: () => new KieImageProvider(),
  mock: () => new MockImageProvider(),
};

const videoProviders: Record<string, () => VideoProvider> = {
  // Generates speech-synchronised motion from the voice track, so no lip-sync
  // repair pass is needed. See docs/PROVIDERS.md.
  kie: () => new KieSeedanceVideoProvider(),
  mock: () => new MockVideoProvider(),
};

const voiceProviders: Record<string, () => VoiceProvider> = {
  elevenlabs: () => new ElevenLabsVoiceProvider(),
  kie: () => new KieVoiceProvider(),
  mock: () => new MockVoiceProvider(),
};

const lipSyncProviders: Record<string, () => LipSyncProvider> = {
  kie: () => new KieLipSyncProvider(),
  mock: () => new MockLipSyncProvider(),
};

const llmProviders: Record<string, () => LLMProvider> = {
  anthropic: () => new AnthropicLLMProvider(),
  mock: () => new MockLLMProvider(),
};

function resolve<T>(
  registry: Record<string, () => T>,
  name: string,
  kind: string,
): T {
  const factory = registry[name];
  if (!factory) {
    throw new Error(
      `Unknown ${kind} provider "${name}". Available: ${Object.keys(registry).join(", ")}`,
    );
  }
  return factory();
}

/**
 * Providers are stateless and cheap, but caching keeps mock task state (which
 * lives in a module-level map) coherent across calls within a process. The
 * cache is keyed by the selected provider name so changing the selection on the
 * Settings page takes effect on the very next call, with no restart.
 */
const cache = new Map<string, unknown>();

function cached<T>(kind: string, registry: Record<string, () => T>, name: string): T {
  const key = `${kind}:${name}`;
  const existing = cache.get(key);
  if (existing) return existing as T;
  const instance = resolve(registry, name, kind);
  cache.set(key, instance);
  return instance;
}

export function imageProvider(): ImageProvider {
  return cached("image", imageProviders, selectedProviders().image);
}

export function videoProvider(): VideoProvider {
  return cached("video", videoProviders, selectedProviders().video);
}

export function voiceProvider(): VoiceProvider {
  return cached("voice", voiceProviders, selectedProviders().voice);
}

export function lipSyncProvider(): LipSyncProvider {
  return cached("lipSync", lipSyncProviders, selectedProviders().lipSync);
}

export function llmProvider(): LLMProvider {
  return cached("llm", llmProviders, selectedProviders().llm);
}

/**
 * Available provider names per kind — used to populate the Settings page.
 *
 * `kie` is withheld from the voice list. It stays in the registry so an
 * operator whose account works can still select it with VOICE_PROVIDER=kie,
 * but it is not an option anyone should be able to pick by accident: KIE's
 * ElevenLabs passthrough answers every request with "internal error, please
 * try again later", including KIE's own documented example payload. Offering
 * it in a dropdown alongside two routes that work is offering a trap, and the
 * error it produces reads like a transient outage rather than a dead path.
 */
export function availableProviders() {
  return {
    image: Object.keys(imageProviders),
    video: Object.keys(videoProviders),
    voice: Object.keys(voiceProviders).filter((name) => name !== "kie"),
    lipSync: Object.keys(lipSyncProviders),
    llm: Object.keys(llmProviders),
  };
}
