/**
 * Speech mode (on_camera | voiceover) — deterministic checks.
 *
 * Offline by construction: every provider is the mock, the network is stubbed
 * so any accidental real request fails loudly, and the database lives in a
 * fresh temp directory. Run with `npm run test:speech-mode`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-studio-speech-mode-"));
process.env.DATA_DIR = testDir;
for (const kind of ["IMAGE", "VIDEO", "VOICE", "LIPSYNC", "LLM"]) {
  process.env[`${kind}_PROVIDER`] = "mock";
}
// A dummy (never valid) key so the one stubbed upload below can be exercised;
// every other network call is refused.
process.env.KIE_API_KEY = "speech-mode-test-dummy-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ELEVENLABS_API_KEY;

const networkCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  networkCalls.push(url);
  if (url.includes("file-base64-upload")) {
    return new Response(
      JSON.stringify({ code: 200, msg: "ok", data: { downloadUrl: "https://example.test/voice.mp3" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`Network forbidden in speech-mode tests: ${url}`);
}) as typeof fetch;

/** Fingerprints computed by the code as it stood before speechMode existed. */
const LEGACY = {
  visual: "74f9a2ee52ec8aba67503ee3",
  voice: "e408f3da113374b9cf82eb29",
  video: "3c8db13869c899587e073cce",
};
const LEGACY_SPEC = {
  locationKey: "harbour",
  shotType: "medium",
  cameraMove: "static",
  subjectAngle: "three_quarter",
  action: "{CREATOR} walks the harbour wall",
  facialExpression: "relaxed",
  pose: "walking",
  wardrobe: "",
  environment: "Venetian harbour",
  lighting: "late sun",
  mood: "calm",
  styleNotes: "phone video",
  motion: "{CREATOR} strolls past the boats",
} as const;
const LEGACY_DIALOGUE = "Follow the waterfront past the old Venetian shipyards.";

function jsonRequest(body: unknown, method = "POST") {
  return new Request("http://localhost/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("speech mode", async (t) => {
  try {
    const fp = await import("@/lib/scene-fingerprint");
    const { assets, cancellation, creators, jobs, projects, scenes } = await import("@/lib/repo");
    const { DEFAULT_PROJECT_SETTINGS, DEFAULT_VOICE } = await import("@/lib/types");
    const types = await import("@/lib/types");
    const schemas = await import("@/lib/ai/schemas");
    const { compileVideoPrompt } = await import("@/lib/prompting");
    const { generateStoryboard, parseInstruction } = await import("@/lib/ai/storyboard");
    const registry = await import("@/lib/providers/registry");
    const { handlers } = await import("@/lib/jobs/handlers");
    const { POST: render } = await import("@/app/api/projects/[id]/render/route");
    const { PATCH: patchScene } = await import("@/app/api/scenes/[id]/route");
    const { POST: approveStoryboard } = await import(
      "@/app/api/projects/[id]/approve-storyboard/route"
    );
    const { POST: approveStill } = await import("@/app/api/scenes/[id]/approve-still/route");

    // ---- fingerprints -----------------------------------------------------
    await t.test("legacy fingerprints are byte-identical for unset and on_camera", () => {
      for (const spec of [
        { ...LEGACY_SPEC },
        { ...LEGACY_SPEC, speechMode: "on_camera" as const },
      ]) {
        const scene = { spec: spec as never, dialogue: LEGACY_DIALOGUE, durationSeconds: 6 };
        assert.equal(fp.visualFingerprint(scene), LEGACY.visual);
        assert.equal(fp.voiceFingerprint(scene), LEGACY.voice);
        assert.equal(fp.videoFingerprint(scene), LEGACY.video);
      }
    });

    await t.test("voiceover invalidates the video only, never the still or the voice", () => {
      const scene = {
        spec: { ...LEGACY_SPEC, speechMode: "voiceover" } as never,
        dialogue: LEGACY_DIALOGUE,
        durationSeconds: 6,
      };
      assert.equal(fp.visualFingerprint(scene), LEGACY.visual);
      assert.equal(fp.voiceFingerprint(scene), LEGACY.voice);
      assert.notEqual(fp.videoFingerprint(scene), LEGACY.video);
    });

    // ---- types / schemas --------------------------------------------------
    await t.test("SPEECH_MODES and Zod/LLM schemas carry speechMode", () => {
      assert.deepEqual([...types.SPEECH_MODES], [
        "on_camera",
        "voiceover",
      ]);
      const base = { ...LEGACY_SPEC };
      assert.equal(schemas.parseSceneSpec(base).speechMode, undefined, "legacy specs stay unset");
      assert.equal(schemas.parseSceneSpec({ ...base, speechMode: "voiceover" }).speechMode, "voiceover");
      assert.throws(() => schemas.parseSceneSpec({ ...base, speechMode: "singing" }));
      const json = schemas.sceneSpecSchema as { properties: Record<string, { enum?: string[] }> };
      assert.deepEqual(json.properties.speechMode?.enum, ["on_camera", "voiceover"]);
    });

    await t.test("mock storyboard output names a speech mode for every scene", async () => {
      const creator = makeCreator();
      const plan = await generateStoryboard({
        brief: "A narrated travel reel: walking the old harbour, voice-over B-roll.",
        creator,
        settings: { ...DEFAULT_PROJECT_SETTINGS, targetDurationSeconds: 15, requestedSceneCount: 2 },
        clipLimits: { min: 3, max: 15 },
      });
      assert.ok(plan.scenes.length > 0);
      for (const scene of plan.scenes) {
        assert.ok(types.SPEECH_MODES.includes(scene.spec.speechMode!), "mock emits a mode");
        assert.ok(scene.dialogue.trim().length > 0, "narration is preserved in voiceover");
      }
      assert.ok(plan.scenes.some((s) => s.spec.speechMode === "voiceover"));
    });

    await t.test("instruction refinement keeps an existing voiceover mode", async () => {
      const creator = makeCreator();
      const refined = await parseInstruction({
        instruction: "Wide shot at sunset",
        creator,
        base: { ...LEGACY_SPEC, speechMode: "voiceover" } as never,
      });
      assert.equal(refined.speechMode, "voiceover");
    });

    // ---- prompting --------------------------------------------------------
    await t.test("voiceover compiles non-speaking motion and never sends the words", () => {
      const spec = { ...LEGACY_SPEC, speechMode: "voiceover" } as never;
      const prompt = compileVideoPrompt(spec, "", {
        dialogue: LEGACY_DIALOGUE,
        speaking: false,
        voiceover: true,
        look: "social",
      } as never);
      assert.ok(!prompt.includes(LEGACY_DIALOGUE.slice(0, 20)), "no script in the video prompt");
      assert.doesNotMatch(prompt, /speaking directly to the camera/i);
      assert.doesNotMatch(prompt, /in time with every word/i);
      assert.match(prompt, /strolls past the boats/, "uses the shot's own motion beat");
      assert.match(prompt, /voice-over/i);
      const onCamera = compileVideoPrompt({ ...LEGACY_SPEC } as never, "", {
        dialogue: LEGACY_DIALOGUE,
        speaking: true,
        look: "social",
      });
      assert.match(onCamera, /speaking directly to the camera/i, "on-camera prompt unchanged");
    });

    // ---- fixture project --------------------------------------------------
    const creator = makeCreator();
    const persisted = creators.create(creator);
    creators.addReference({
      creatorId: persisted.id,
      kind: "seed",
      angle: "front",
      remoteUrl: "https://example.test/identity.png",
      localPath: null,
      isAnchor: true,
    });
    /**
     * Routes kick the background runner (setTimeout 0). Cancelling synchronously
     * right after each awaited route call — before the timer can fire — keeps
     * the queue empty so no background job races the spies below.
     */
    const quiesce = () => cancellation.cancelPending({ creatorId: persisted.id });

    function makeProject(audioMode: "lipsync" | "mux" | "separate", speechMode?: "on_camera" | "voiceover") {
      const project = projects.create({
        title: `speech ${audioMode} ${speechMode ?? "unset"}`,
        prompt: "Narrated harbour walk.",
        creatorId: persisted.id,
        settings: { ...DEFAULT_PROJECT_SETTINGS, audioMode, targetDurationSeconds: 6, requestedSceneCount: 1 },
      });
      const [scene] = projects.replaceScenes(project.id, [
        {
          title: "Harbour",
          dialogue: LEGACY_DIALOGUE,
          durationSeconds: 6,
          spec: (speechMode ? { ...LEGACY_SPEC, speechMode } : { ...LEGACY_SPEC }) as never,
        },
      ]);
      projects.approveStoryboard(project.id);
      const image = assets.create({
        kind: "image",
        projectId: project.id,
        sceneId: scene.id,
        creatorId: persisted.id,
        remoteUrl: "https://example.test/still.png",
        meta: { visualFingerprint: fp.visualFingerprint(scene) },
      });
      scenes.approveImage(scene.id, image.id);
      return { project, scene: scenes.get(scene.id)!, image };
    }

    // Spy on every paid provider. Patched on the cached instances the
    // handlers resolve, so any call is observed.
    const video = registry.videoProvider() as unknown as {
      submit: (r: Record<string, unknown>) => Promise<unknown>;
      speaksFromVoice?: boolean;
      voiceReferenceSeconds?: { min: number; max: number };
    };
    const videoRequests: Record<string, unknown>[] = [];
    const realVideoSubmit = video.submit.bind(video);
    video.submit = async (request) => {
      videoRequests.push(request);
      return realVideoSubmit(request);
    };
    // Behave like the production model: performs speech from a voice file.
    Object.defineProperty(video, "speaksFromVoice", { value: true, configurable: true });
    Object.defineProperty(video, "voiceReferenceSeconds", { value: { min: 0.1, max: 15 }, configurable: true });
    const voice = registry.voiceProvider() as unknown as { submit: (r: unknown) => Promise<unknown> };
    let voiceSubmits = 0;
    const realVoiceSubmit = voice.submit.bind(voice);
    voice.submit = async (request) => {
      voiceSubmits += 1;
      return realVoiceSubmit(request);
    };
    const lipSync = registry.lipSyncProvider() as unknown as { submit: (r: unknown) => Promise<unknown> };
    let lipSyncSubmits = 0;
    const realLipSubmit = lipSync.submit.bind(lipSync);
    lipSync.submit = async (request) => {
      lipSyncSubmits += 1;
      return realLipSubmit(request);
    };

    function context(job: ReturnType<typeof jobs.create>) {
      return {
        job,
        setProgress() {},
        async awaitTask(
          handle: unknown,
          poll: (h: never) => Promise<{ status: string; error?: string }>,
        ) {
          for (let i = 0; i < 20; i += 1) {
            const result = await poll(handle as never);
            if (result.status === "succeeded") return result;
            if (result.status === "failed") throw new Error(result.error ?? "failed");
          }
          throw new Error("mock task did not finish");
        },
      } as never;
    }

    // ---- public route gate ------------------------------------------------
    await t.test("route: on_camera + mux rejects video before anything is queued", async () => {
      for (const mode of [undefined, "on_camera"] as const) {
        const { project } = makeProject("mux", mode);
        const before = jobs.forProject(project.id).length;
        const response = await render(jsonRequest({ stages: ["video"] }), {
          params: Promise.resolve({ id: project.id }),
        });
        quiesce();
        assert.equal(response.status, 409);
        const body = (await response.json()) as { error?: string };
        const text = JSON.stringify(body);
        assert.match(text, /lip-?sync/i, "offers lip sync");
        assert.match(text, /voice-?over/i, "offers voice-over");
        assert.equal(jobs.forProject(project.id).length, before, "nothing queued");
        // voice + video in one request is rejected as a whole
        const both = await render(jsonRequest({ stages: ["voice", "video"] }), {
          params: Promise.resolve({ id: project.id }),
        });
        quiesce();
        assert.equal(both.status, 409);
        assert.equal(jobs.forProject(project.id).length, before, "nothing queued");
      }
    });

    await t.test("route: voice-only and image stages are not blocked by the gate", async () => {
      const { project } = makeProject("mux", "on_camera");
      const voiceOnly = await render(jsonRequest({ stages: ["voice"] }), {
        params: Promise.resolve({ id: project.id }),
      });
      quiesce();
      assert.equal(voiceOnly.status, 202);
      const image = await render(jsonRequest({ stages: ["image"] }), {
        params: Promise.resolve({ id: project.id }),
      });
      quiesce();
      assert.equal(image.status, 202);
    });

    await t.test("route: voiceover + mux, and on_camera + lipsync, may queue video", async () => {
      for (const [audio, mode] of [["mux", "voiceover"], ["lipsync", "on_camera"], ["lipsync", undefined]] as const) {
        const { project } = makeProject(audio, mode);
        const response = await render(jsonRequest({ stages: ["video"] }), {
          params: Promise.resolve({ id: project.id }),
        });
        quiesce();
        assert.equal(response.status, 202, `${audio}/${mode}`);
      }
    });

    // ---- handler gate (direct queued job) --------------------------------
    await t.test("handler: a queued on_camera + mux job fails before any paid call", async () => {
      const { project, scene } = makeProject("mux", "on_camera");
      const job = jobs.create({
        type: "scene_video",
        projectId: project.id,
        sceneId: scene.id,
        creatorId: persisted.id,
        payload: { creatorId: persisted.id },
      });
      const v = videoRequests.length;
      const s = voiceSubmits;
      const l = lipSyncSubmits;
      const n = networkCalls.length;
      await assert.rejects(handlers.scene_video(context(job)), (error: Error) => {
        assert.match(error.message, /lip-?sync/i);
        assert.match(error.message, /voice-?over/i);
        return true;
      });
      assert.equal(videoRequests.length, v, "no video request");
      assert.equal(voiceSubmits, s, "no voice request");
      assert.equal(lipSyncSubmits, l, "no lip-sync request");
      assert.equal(networkCalls.length, n, "no network");
      assert.equal(assets.latestForScene(scene.id, "video", persisted.id), null);
      quiesce();
    });

    await t.test("handler: voiceover never sends the waveform or words to the video model", async () => {
      const { project, scene } = makeProject("lipsync", "voiceover");
      const job = jobs.create({
        type: "scene_video",
        projectId: project.id,
        sceneId: scene.id,
        creatorId: persisted.id,
        payload: { creatorId: persisted.id },
      });
      const v = videoRequests.length;
      const l = lipSyncSubmits;
      const n = networkCalls.length;
      await handlers.scene_video(context(job));
      quiesce();
      assert.equal(videoRequests.length, v + 1, "exactly one video request");
      const request = videoRequests.at(-1)!;
      assert.equal(request.voiceUrl, undefined, "no speech waveform to the native path");
      assert.equal(request.dialogue, undefined, "no words to the video model");
      assert.doesNotMatch(String(request.prompt), /speaking directly to the camera/i);
      assert.doesNotMatch(String(request.prompt), /Venetian shipyards/);
      assert.equal(lipSyncSubmits, l, "no lip-sync pass for voiceover");
      assert.equal(networkCalls.length, n, "voice was not published anywhere");
      const clip = assets.latestForScene(scene.id, "video", persisted.id)!;
      assert.ok(clip);
      assert.equal(clip.meta.audioModeRequested, "mux", "narration is overlaid as recorded");
      assert.equal(clip.meta.speechMode, "voiceover");
      assert.equal(clip.meta.videoFingerprint, fp.videoFingerprint(scenes.get(scene.id)!));
      assert.equal(scenes.get(scene.id)!.dialogue, LEGACY_DIALOGUE, "narration preserved");
    });

    await t.test("handler: legacy on_camera + lipsync still performs from the voice", async () => {
      const { project, scene } = makeProject("lipsync");
      const job = jobs.create({
        type: "scene_video",
        projectId: project.id,
        sceneId: scene.id,
        creatorId: persisted.id,
        payload: { creatorId: persisted.id },
      });
      await handlers.scene_video(context(job));
      quiesce();
      const request = videoRequests.at(-1)!;
      assert.equal(request.voiceUrl, "https://example.test/voice.mp3");
      assert.equal(request.dialogue, LEGACY_DIALOGUE);
      assert.match(String(request.prompt), /speaking directly to the camera/i);
      const clip = assets.latestForScene(scene.id, "video", persisted.id)!;
      assert.equal(clip.meta.videoFingerprint, LEGACY.video, "legacy video hash unchanged");
    });

    // ---- editing --------------------------------------------------------
    await t.test("PATCH: sets, keeps and validates speechMode; still stays reusable", async () => {
      const { project, scene, image } = makeProject("mux");
      const voiceAsset = assets.create({
        kind: "audio",
        projectId: project.id,
        sceneId: scene.id,
        creatorId: persisted.id,
        localPath: null,
        remoteUrl: null,
        meta: { voiceFingerprint: fp.voiceFingerprint(scene) },
      });
      const params = { params: Promise.resolve({ id: scene.id }) };
      // The shot editor sends the full spec, locationKey included (key order
      // matters to the pre-existing JSON hashes, so mirror the real payload).
      const wire = { ...LEGACY_SPEC };
      let response = await patchScene(jsonRequest({ spec: { ...wire, speechMode: "voiceover" } }, "PATCH"), params);
      assert.equal(response.status, 200);
      let updated = scenes.get(scene.id)!;
      assert.equal(updated.spec.speechMode, "voiceover");
      // A later edit that does not mention the mode keeps it.
      response = await patchScene(jsonRequest({ spec: { ...wire, mood: "calmer" } }, "PATCH"), params);
      assert.equal(response.status, 200);
      updated = scenes.get(scene.id)!;
      assert.equal(updated.spec.speechMode, "voiceover");
      response = await patchScene(jsonRequest({ spec: { ...wire, speechMode: "mumbling" } }, "PATCH"), params);
      assert.equal(response.status, 422, "invalid mode is a validation error");
      // Back to the original shot, voiceover: the same still and voice are valid.
      response = await patchScene(jsonRequest({ spec: { ...wire, speechMode: "voiceover" } }, "PATCH"), params);
      updated = scenes.get(scene.id)!;
      assert.equal(fp.visualFingerprint(updated), image.meta.visualFingerprint, "still not invalidated");
      assert.equal(fp.voiceFingerprint(updated), voiceAsset.meta.voiceFingerprint, "voice not invalidated");
      // Human approvals still gate: the edit revoked them, re-approval reuses the existing still.
      assert.equal(projects.get(project.id)!.storyboardApprovedAt, null);
      assert.equal(updated.approvedImageAssetId, null);
      let r = await approveStoryboard(new Request("http://localhost/x", { method: "POST" }), {
        params: Promise.resolve({ id: project.id }),
      });
      assert.equal(r.status, 200);
      r = await approveStill(new Request("http://localhost/x", { method: "POST" }), params);
      assert.equal(r.status, 200, "existing still re-approvable without regeneration");
      assert.equal(scenes.get(scene.id)!.approvedImageAssetId, image.id);
      // And now the mux project may render this narrated shot.
      r = await render(jsonRequest({ stages: ["video"] }), { params: Promise.resolve({ id: project.id }) });
      quiesce();
      assert.equal(r.status, 202);
    });
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

function makeCreator() {
  return {
    name: "Speech Mode Test",
    category: "Travel",
    persona: "Calm travel narrator",
    identity: {
      canonical: "A consistent adult presenter.",
      face: "Oval face.",
      hair: "Black shoulder-length hair.",
      skinTone: "Warm brown skin.",
      bodyType: "Average build.",
      distinguishingFeatures: "",
      wardrobe: "Black shirt.",
      negative: "different person",
    },
    voice: {
      provider: "elevenlabs",
      voiceId: "test-voice",
      label: "Test",
      stability: 0,
      similarityBoost: 0.9,
      style: 0.35,
      speed: 1,
    },
    status: "ready" as const,
  } as never;
}
