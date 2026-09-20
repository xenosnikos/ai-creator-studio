import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-studio-approval-"));
process.env.DATA_DIR = testDir;
process.env.IMAGE_PROVIDER = "mock";
process.env.VIDEO_PROVIDER = "mock";
process.env.VOICE_PROVIDER = "mock";
process.env.LIPSYNC_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";

async function main() {
const { assets, creators, projects, scenes } = await import("@/lib/repo");
const { DEFAULT_PROJECT_SETTINGS, DEFAULT_VOICE } = await import("@/lib/types");
const { generateStoryboard } = await import("@/lib/ai/storyboard");
const { visualFingerprint } = await import("@/lib/scene-fingerprint");
const { POST: approveStoryboard } = await import(
  "@/app/api/projects/[id]/approve-storyboard/route"
);
const { POST: approveStill } = await import("@/app/api/scenes/[id]/approve-still/route");
const { POST: render } = await import("@/app/api/projects/[id]/render/route");

const creator = creators.create({
  name: "Approval Test",
  category: "Test",
  persona: "Direct",
  identity: {
    canonical: "A consistent adult presenter.",
    face: "Oval face.",
    hair: "Black shoulder-length hair.",
    skinTone: "Warm brown skin.",
    bodyType: "Average build.",
    distinguishingFeatures: "",
    wardrobe: "Black shirt.",
    negative: "different person, changed hair, changed outfit",
  },
  voice: DEFAULT_VOICE,
  status: "ready",
});
creators.addReference({
  creatorId: creator.id,
  kind: "seed",
  angle: "front",
  remoteUrl: "https://example.test/identity.png",
  localPath: null,
  isAnchor: true,
});

const settings = {
  ...DEFAULT_PROJECT_SETTINGS,
  targetDurationSeconds: 15,
  requestedSceneCount: 1,
};
const project = projects.create({
  title: "Approval test",
  prompt: "Explain one useful idea to camera in one continuous shot.",
  creatorId: creator.id,
  settings,
});
const [scene] = projects.replaceScenes(project.id, [
  {
    title: "One continuous shot",
    dialogue: "",
    durationSeconds: 15,
    spec: {
      locationKey: "studio",
      shotType: "medium_close_up",
      cameraMove: "static",
      subjectAngle: "front",
      action: "{CREATOR} addresses the camera",
      facialExpression: "focused",
      pose: "standing",
      wardrobe: "",
      environment: "simple studio",
      lighting: "soft window light",
      mood: "clear",
      styleNotes: "real phone footage",
      motion: "{CREATOR} speaks naturally",
    },
  },
]);

function request(body: unknown) {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let response = await render(request({ stages: ["image"] }), {
  params: Promise.resolve({ id: project.id }),
});
assert.equal(response.status, 409, "preview stills must be blocked before storyboard approval");

response = await approveStoryboard(new Request("http://localhost/test", { method: "POST" }), {
  params: Promise.resolve({ id: project.id }),
});
assert.equal(response.status, 200);
assert.ok(projects.get(project.id)?.storyboardApprovedAt);

const firstImage = assets.create({
  kind: "image",
  projectId: project.id,
  sceneId: scene.id,
  creatorId: creator.id,
  remoteUrl: "https://example.test/first.png",
  meta: { visualFingerprint: visualFingerprint(scene) },
});
response = await render(request({ stages: ["video"] }), {
  params: Promise.resolve({ id: project.id }),
});
assert.equal(response.status, 409, "video must be blocked until the still is approved");

response = await approveStill(new Request("http://localhost/test", { method: "POST" }), {
  params: Promise.resolve({ id: scene.id }),
});
assert.equal(response.status, 200);
assert.equal(scenes.get(scene.id)?.approvedImageAssetId, firstImage.id);

const replacementImage = assets.create({
  kind: "image",
  projectId: project.id,
  sceneId: scene.id,
  creatorId: creator.id,
  remoteUrl: "https://example.test/replacement.png",
  meta: { visualFingerprint: visualFingerprint(scene) },
});
response = await render(request({ stages: ["video"] }), {
  params: Promise.resolve({ id: project.id }),
});
assert.equal(response.status, 409, "approval of an older still must not authorise a replacement");
assert.notEqual(firstImage.id, replacementImage.id);

response = await approveStill(new Request("http://localhost/test", { method: "POST" }), {
  params: Promise.resolve({ id: scene.id }),
});
assert.equal(response.status, 200);
response = await render(request({ stages: ["voice"] }), {
  params: Promise.resolve({ id: project.id }),
});
assert.equal(response.status, 202, "an approved current still should unlock production");

scenes.update(scene.id, { dialogue: "These corrected words are now the project script." });
assert.equal(projects.get(project.id)?.storyboardApprovedAt, null, "editing must revoke plan approval");
assert.equal(scenes.get(scene.id)?.approvedImageAssetId, null, "editing must revoke still approval");
assert.equal(
  projects.get(project.id)?.transcript,
  "These corrected words are now the project script.",
  "per-scene word edits must keep the full transcript in sync",
);

const planned = await generateStoryboard({
  brief: "Explain one useful idea to camera in one continuous shot.",
  creator,
  settings,
  clipLimits: { min: 3, max: 15 },
});
assert.equal(planned.scenes.length, 1, "an exact one-scene request must stay one scene");

console.log("approval workflow checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
