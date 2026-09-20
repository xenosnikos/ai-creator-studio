import { config } from "@/lib/config";
import { createTask, pollTask, truncate } from "@/lib/providers/kie/client";
import type {
  TaskHandle,
  TaskResult,
  VoiceOption,
  VoiceProvider,
  VoiceRequest,
} from "@/lib/providers/types";

const MAX_TEXT_CHARS = 5000;

/**
 * Voices selectable on KIE.
 *
 * These are ElevenLabs voice ids. KIE's own API documentation uses them
 * verbatim in its request example (`"voice": "TX3LPaxmHKxFdv7VOQHJ"`), which
 * settles a question its playground obscures — the picker there shows friendly
 * names like "James - Husky, Engaging and Bold", but the value on the wire is
 * the id.
 */
export const ELEVENLABS_VOICES: VoiceOption[] = [
  // The app's default voice comes first. It was missing from this list
  // entirely, so the voice picker had no option matching the value it was
  // bound to and every browser fell back to displaying the first entry — a
  // male voice — while the creator was actually built with the default. The
  // operator saw one name and got another.
  { id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura — young, upbeat social (F)", source: "account" },
  // The ids below appear in KIE's documented example, so they are known-good.
  { id: "NNl6r8mD7vthiJatiJt1", label: "Bradford — deep, authoritative (M)", source: "account" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam — energetic, social creator (M)", source: "account" },
  { id: "EkK5I93UQWFDigLMpZcX", label: "James — husky, engaging and bold (M)", source: "account" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — calm, narrative (F)", source: "account" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi — confident, punchy (F)", source: "account" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — friendly, conversational (M)", source: "account" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli — youthful, energetic (F)", source: "account" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — casual, upbeat (M)", source: "account" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold — assertive, gravelly (M)", source: "account" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — neutral, documentary (M)", source: "account" },
  { id: "yoZ06aMxZJJ28mfd3POQ", label: "Sam — dry, precise (M)", source: "account" },
  { id: "ThT5KcBeYPX3keUQqHPh", label: "Dorothy — soft, reassuring (F)", source: "account" },
];

/**
 * ElevenLabs multilingual v2 via KIE.
 *
 * Voice consistency comes from three things, all enforced here: the voice id is
 * locked on the creator, the stability/similarity knobs travel with it, and
 * adjacent script text is passed as prosody context so scene-to-scene delivery
 * does not reset between clips.
 */
export class KieVoiceProvider implements VoiceProvider {
  readonly name = "kie:elevenlabs";

  async submit(request: VoiceRequest): Promise<TaskHandle> {
    const { voice } = request;
    const model = config.kie.models.voiceTTS;
    const text = truncate(request.text, MAX_TEXT_CHARS);

    // The text-to-dialogue models take a different shape: a `dialogue` array of
    // {text, voice} turns rather than a flat text + voice pair. Same vendor,
    // same account, incompatible schema — so the adapter branches on the id.
    if (/text-to-dialogue/.test(model)) {
      const dialogueInput: Record<string, unknown> = {
        // A real JSON array. KIE's docs declare this field as `string` and show
        // a stringified array in the example — that form is rejected by the
        // service's own parser ("expect {, actual string"). The array is what
        // it actually accepts.
        dialogue: [{ text, voice: voice.voiceId }],
        stability: clamp(voice.stability, 0, 1),
      };
      // Only send a language when one is set. The documented default of "auto"
      // is rejected with a 422 naming the parameter, so it cannot be sent.
      if (voice.languageCode) dialogueInput.language_code = voice.languageCode;
      const taskId = await createTask(model, dialogueInput);
      return { taskId, provider: this.name };
    }

    const input: Record<string, unknown> = {
      text,
      // A KIE voice *name* ("James"), not an ElevenLabs voice id — see the
      // ELEVENLABS_VOICES note above.
      voice: voice.voiceId,
      stability: clamp(voice.stability, 0, 1),
      similarity_boost: clamp(voice.similarityBoost, 0, 1),
      style: clamp(voice.style, 0, 1),
      speed: clamp(voice.speed, 0.7, 1.2),
    };
    if (request.previousText) input.previous_text = truncate(request.previousText, MAX_TEXT_CHARS);
    if (request.nextText) input.next_text = truncate(request.nextText, MAX_TEXT_CHARS);
    if (voice.languageCode) input.language_code = voice.languageCode;

    const taskId = await createTask(model, input);
    return { taskId, provider: this.name };
  }

  poll(handle: TaskHandle): Promise<TaskResult> {
    return pollTask(handle.taskId);
  }

  async listVoices(): Promise<VoiceOption[]> {
    return ELEVENLABS_VOICES;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

