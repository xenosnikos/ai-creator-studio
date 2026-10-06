import type { LLMJsonRequest, LLMProvider } from "@/lib/providers/types";
import type { CameraMove, IdentityAngle, ShotType, SpeechMode } from "@/lib/types";

/**
 * Deterministic stand-in for Claude.
 *
 * It produces schema-valid output for every pipeline stage so the app can be
 * demoed and tested end-to-end with no API key. Output is intentionally
 * formulaic — it exists to exercise wiring, not to be good writing.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock:llm";

  async json<T>(request: LLMJsonRequest<T>): Promise<T> {
    switch (request.task) {
      case "identity_block":
        return request.parse(mockIdentityBlock(request.user));
      case "storyboard":
        return request.parse(mockStoryboard(request.user));
      case "scene_prompt":
        return request.parse(mockSceneSpec(request.user, 0));
    }
  }
}

function mockIdentityBlock(_seed: string) {
  return {
    canonical:
      "A person in their early thirties with an oval face, high cheekbones, warm brown almond-shaped eyes set evenly apart, straight nose with a rounded tip, full lips and a softly defined jawline. Shoulder-length dark brown hair with a natural wave, parted slightly off-centre. Warm medium skin tone with a neutral undertone and an even complexion. Average height with a lean, balanced build, square shoulders and upright posture.",
    face: "Oval face, high cheekbones, warm brown almond eyes, straight nose, full lips, soft jawline.",
    hair: "Shoulder-length dark brown, natural wave, off-centre part.",
    skinTone: "Warm medium, neutral undertone, even complexion.",
    bodyType: "Average height, lean balanced build, square shoulders, upright posture.",
    distinguishingFeatures: "A small mole below the left cheekbone.",
    wardrobe: "Fitted charcoal knit, dark straight-leg trousers, minimal jewellery.",
    negative:
      "different face, altered jawline, changed eye colour, changed hair length, extra facial hair, distorted proportions, inconsistent skin tone",
  };
}

const SHOT_CYCLE: ShotType[] = ["wide", "medium", "medium_close_up", "close_up", "medium_wide"];
const MOVE_CYCLE: CameraMove[] = [
  "slow_push_in",
  "static",
  "tracking",
  "slow_pull_out",
  "handheld",
];
const ANGLE_CYCLE: IdentityAngle[] = [
  "full_body",
  "three_quarter",
  "front",
  "close_up",
  "three_quarter",
];

/** Recover just the brief line from the assembled prompt the caller passed in. */
function topicFrom(text: string): string {
  const match = /BRIEF:\s*(.+)/.exec(text) ?? /INSTRUCTION:\s*(.+)/.exec(text);
  const line = (match?.[1] ?? text).split("\n")[0].replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line || "the topic";
}

/**
 * Narrated briefs get voice-over scenes, everything else stays on camera.
 *
 * Keyword-driven so tests can ask for either deterministically; the real
 * writer decides from the brief as a whole.
 */
function mockSpeechMode(brief: string): SpeechMode {
  return /voice[- ]?over|narrat|b-roll|travel/i.test(topicFrom(brief)) ? "voiceover" : "on_camera";
}

/**
 * `speechMode` is left out of a free-form instruction result on purpose: the
 * caller keeps the scene's existing mode, which is what a refinement that does
 * not mention it should do.
 */
function mockSceneSpec(brief: string, index: number, speechMode?: SpeechMode) {
  const topic = topicFrom(brief);
  const narrated = speechMode === "voiceover";
  return {
    shotType: SHOT_CYCLE[index % SHOT_CYCLE.length],
    cameraMove: MOVE_CYCLE[index % MOVE_CYCLE.length],
    subjectAngle: ANGLE_CYCLE[index % ANGLE_CYCLE.length],
    action: narrated
      ? `{CREATOR} explores a place connected to ${topic}`
      : `{CREATOR} presents to camera about ${topic}`,
    facialExpression: index === 0 ? "warm, welcoming smile" : "engaged, confident",
    pose: index % 2 === 0 ? "standing, weight on one hip, hands relaxed" : "gesturing with one hand",
    wardrobe: "",
    environment: "A clean contemporary interior with depth behind the subject",
    lighting: "Soft key from camera left, gentle rim light, natural falloff",
    mood: "Confident and approachable",
    styleNotes: "Cinematic, 35mm, shallow depth of field, subtle film grain",
    motion: narrated
      ? `{CREATOR} walks slowly and looks around, mouth relaxed; camera ${MOVE_CYCLE[index % MOVE_CYCLE.length].replace(/_/g, " ")}`
      : `{CREATOR} holds the frame and speaks naturally; camera ${MOVE_CYCLE[index % MOVE_CYCLE.length].replace(/_/g, " ")}`,
    ...(speechMode ? { speechMode } : {}),
  };
}

function mockStoryboard(brief: string) {
  // The prompt text carries the requested duration; recover it so scene
  // durations sum correctly and the validator passes.
  const durationMatch = brief.match(/TOTAL DURATION:\s*(\d+(?:\.\d+)?)\s*seconds/i);
  const total = durationMatch ? Number.parseInt(durationMatch[1], 10) : 30;
  const exactVideoCount = brief.match(/SCENE COUNT:\s*EXACTLY\s+(\d+)/i);
  const exactPhotoCount = brief.match(/HOW MANY IMAGES:\s*(\d+)/i);
  const sceneCount = exactVideoCount
    ? Number.parseInt(exactVideoCount[1], 10)
    : exactPhotoCount
      ? Number.parseInt(exactPhotoCount[1], 10)
      : Math.max(1, Math.ceil(total / 15));

  const base = Math.floor(total / sceneCount);
  const durations = Array.from({ length: sceneCount }, (_, i) =>
    i === sceneCount - 1 ? total - base * (sceneCount - 1) : base,
  );

  const lines = [
    "Here's the thing nobody tells you about this.",
    "I spent months figuring this out so you don't have to.",
    "The first move is the one most people skip entirely.",
    "Once you see it this way, you can't unsee it.",
    "That single change did more than everything else combined.",
    "Most people quit right before this part starts working.",
    "Try it for one week and watch what happens.",
    "Follow for more — I break this down every week.",
  ];

  const scenes = durations.map((durationSeconds, i) => ({
    title: `Scene ${i + 1}`,
    durationSeconds: Math.max(3, Math.min(15, durationSeconds)),
    dialogue: lines[i % lines.length],
    spec: mockSceneSpec(brief, i, mockSpeechMode(brief)),
  }));

  return {
    title: "Mock storyboard",
    transcript: scenes.map((s) => s.dialogue).join(" "),
    scenes,
  };
}
