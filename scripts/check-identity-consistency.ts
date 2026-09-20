import assert from "node:assert/strict";

import {
  compileImagePrompt,
  appearanceContinuityReferencePosition,
  identityReferencePositions,
  locationReferencePosition,
  selectReferences,
  wardrobeReferencePosition,
} from "@/lib/prompting";
import type { Creator, CreatorReference, SceneSpec } from "@/lib/types";

const creator: Creator = {
  id: "crt_identity_test",
  name: "Identity Test",
  category: "Test",
  persona: "Test creator",
  appearanceNotes: "",
  look: {},
  identity: {
    canonical: "An adult woman with a long oval face, dark almond eyes and shoulder-length black hair.",
    face: "Long oval face, dark almond eyes, narrow straight nose and defined jaw.",
    hair:
      "Dark brown, nearly black hair worn just past shoulder length with a loose natural wave, parted slightly off-centre rather than razor straight, with shorter strands near the temples and ends with a natural uneven taper rather than a blunt salon cut.",
    skinTone: "Warm olive skin with natural texture.",
    bodyType: "Medium height with a lean build and relaxed posture.",
    distinguishingFeatures: "",
    wardrobe: "White linen blazer over a charcoal silk top with black trousers.",
    negative: "different face, pale skin, blonde hair, short hair, changed haircut",
  },
  voice: {
    provider: "elevenlabs",
    voiceId: "test",
    label: "Test",
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.2,
    speed: 1,
  },
  promptSeed: "locked123",
  status: "ready",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function ref(
  id: string,
  remoteUrl: string,
  kind: CreatorReference["kind"],
  angle: CreatorReference["angle"],
  isAnchor: boolean,
): CreatorReference {
  return {
    id,
    creatorId: creator.id,
    remoteUrl,
    localPath: `creators/${creator.id}/${id}.png`,
    kind,
    angle,
    isAnchor,
    createdAt: new Date(0).toISOString(),
  };
}

const references = [
  ref("seed-front", "https://provider/seed-front.png", "seed", "front", true),
  ref("seed-side", "https://provider/seed-side.png", "seed", "three_quarter", true),
  // This is the regression case: a generated angle can be visibly wrong and
  // must not outrank (or even enter) a scene render until explicitly approved.
  ref("bad-generated-angle", "https://provider/blonde-stranger.png", "sheet", "close_up", false),
  ref("approved-sheet", "https://provider/approved-closeup.png", "sheet", "close_up", true),
];

const wardrobeUrl = "https://provider/wardrobe.png";
const locationUrl = "https://provider/location.png";
const styleUrl = "https://provider/style.png";
const continuityUrl = "https://provider/scene-1.png";
const selected = selectReferences({
  references,
  angle: "close_up",
  wardrobeRefs: [wardrobeUrl],
  continuityRefs: [continuityUrl],
  backgroundRefs: [locationUrl],
  styleRefs: [styleUrl],
});

assert.equal(selected.length <= 8, true, "provider reference cap must be respected");
assert.deepEqual(
  selected.slice(0, 3),
  [
    "https://provider/seed-front.png",
    "https://provider/seed-side.png",
    "https://provider/approved-closeup.png",
  ],
  "verified seed/anchor images must be first",
);
assert.equal(
  selected.includes("https://provider/blonde-stranger.png"),
  false,
  "unreviewed generated sheet images must not condition keyframes",
);

const identityIndices = identityReferencePositions(selected, references);
assert.deepEqual(identityIndices, [1, 2, 3]);
assert.equal(appearanceContinuityReferencePosition(selected, [continuityUrl]), 4);
assert.equal(wardrobeReferencePosition(selected, [wardrobeUrl]), 5);
assert.equal(locationReferencePosition(selected, [locationUrl]), 6);

const scene: SceneSpec = {
  locationKey: "living_room",
  shotType: "medium",
  cameraMove: "static",
  subjectAngle: "close_up",
  action: "{CREATOR} explains the idea directly to camera",
  facialExpression: "calm and focused",
  pose: "seated upright",
  // A later scene must not silently replace the project-wide outfit.
  wardrobe: "blue dress",
  environment: "a bright modern living room",
  lighting: "soft daylight from camera left",
  mood: "confident",
  styleNotes: "natural social footage",
  motion: "{CREATOR} gestures naturally while speaking",
};

const prompt = compileImagePrompt(
  creator,
  scene,
  "natural colour",
  "social",
  0,
  false,
  6,
  false,
  identityIndices,
  "White linen blazer over a charcoal silk top with black trousers.",
  4,
);

assert.match(prompt, /IDENTITY GROUND TRUTH: REFERENCE IMAGES 1, 2, 3/);
assert.match(prompt, /White linen blazer over a charcoal silk top with black trousers/i);
assert.doesNotMatch(prompt, /blue dress/i);
assert.match(prompt, /APPEARANCE CONTINUITY: REFERENCE IMAGE 4 is scene 1/i);
assert.match(prompt, /haircut, hair length, part position/i);
assert.match(prompt, /complete outfit exactly/i);
assert.match(
  prompt,
  /natural uneven taper rather than a blunt salon cut/i,
  "prompt compression must never discard the exact haircut tail",
);
assert.match(prompt, /location, wardrobe or style reference is NOT the subject/i);
assert.equal(prompt.length <= 4800, true);
assert.match(prompt, /CAMERA:/, "identity locking must not squeeze out camera instructions");
assert.match(prompt, /STYLE:/, "identity locking must not truncate the prompt tail");

console.log("identity consistency checks passed");
