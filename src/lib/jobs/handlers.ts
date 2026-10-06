import { generateStoryboard } from "@/lib/ai/storyboard";
import { config } from "@/lib/config";
import { measureVoiceAsset, round, synthesizeSceneVoice } from "@/lib/jobs/voice";
import { rm, writeFile } from "node:fs/promises";

import sharp from "sharp";

import {
  ROOM_TONE_MIX,
  applyRoomTone,
  concatVideos,
  ffmpegAvailable,
  mixBackgroundMusic,
  muxAudioOntoVideo,
  trimTrailingSilence,
} from "@/lib/media/ffmpeg";
import { composeMusic } from "@/lib/providers/elevenlabs/music";
import { findLocationPhoto, locationSearchQuery } from "@/lib/media/location-photo";
import { voicePace } from "@/lib/media/voice-pace";
import {
  compileBootstrapPrompt,
  compileIdentitySheetPrompt,
  compileImagePrompt,
  compilePlatePrompt,
  compileVideoPrompt,
  garmentSwapPrompt,
  appearanceContinuityReferencePosition,
  identityReferencePositions,
  locationReferencePosition,
  selectReferences,
  wardrobeReferencePosition,
} from "@/lib/prompting";
import {
  providerReadyContextReferences,
  providerReadyCreatorReferences,
  providerReadyStoredReference,
} from "@/lib/creators/references";
import { imageProvider, lipSyncProvider, videoProvider } from "@/lib/providers/registry";
import { assets, creators, jobs, plates, projects, scenes } from "@/lib/repo";
import { uploadBase64 } from "@/lib/providers/kie/client";
import {
  audioModeForScene,
  effectiveSpeechMode,
  isVoiceover,
  speechModeGate,
} from "@/lib/speech-mode";
import { absoluteAssetPath, persistFromUrl, readAsset } from "@/lib/storage";
import { videoFingerprint, visualFingerprint, voiceFingerprint } from "@/lib/scene-fingerprint";
import {
  DEFAULT_IDENTITY_ANGLES,
  type Asset,
  type AudioMode,
  type AudioOutcome,
  type Creator,
  type CreatorReference,
  type IdentityAngle,
  type JobType,
  type Project,
  type Scene,
  type ShotType,
} from "@/lib/types";

import type { JobContext, JobHandler } from "@/lib/jobs/runner";
import type { TaskResult } from "@/lib/providers/types";

/**
 * Job handlers — one per pipeline stage.
 *
 * Each handler is written so it can be re-run safely: rendering a scene image
 * twice produces two assets and the newest wins, rather than mutating state in
 * place. That makes "regenerate this shot" and "swap the creator" the same
 * operation from the system's point of view.
 */

// ---------------------------------------------------------------------------
// Storyboard + script
// ---------------------------------------------------------------------------

const storyboard: JobHandler = async ({ job, setProgress }) => {
  const projectId = requireId(job.projectId, "projectId");
  const project = projects.get(projectId);
  if (!project) throw new Error("Project not found");
  const creator = creators.get(project.creatorId);
  if (!creator) throw new Error("Creator not found");

  setProgress(10);

  const referenceNotes = [
    project.backgroundRefs.length
      ? `${project.backgroundRefs.length} photo(s) of the actual place supplied — every scene happens ` +
        `THERE. Write environments that match those photos rather than inventing a location, and keep ` +
        `the same locationKey across scenes set in it.`
      : "",
    // Without this the writer keeps filling in wardrobe text of its own, which
    // then argues with the photo at render time — two different outfits
    // described to the same model.
    project.wardrobeRefs.length
      ? `A photo of the outfit is supplied, so leave every scene's "wardrobe" field EMPTY unless the ` +
        `story genuinely requires a change of clothes. The garment comes from the photo, not from you.`
      : "",
    project.styleRefs.length
      ? `${project.styleRefs.length} style reference image(s) supplied — match their grade and rendering.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Hand the writer the renderer's real clip limits so the shot list it
  // produces is one this pipeline can actually render.
  const video = videoProvider();
  const result = await generateStoryboard({
    brief: project.prompt,
    creator,
    settings: project.settings,
    referenceNotes: referenceNotes || undefined,
    clipLimits: { min: video.minClipSeconds, max: video.maxClipSeconds },
    minSpokenSeconds: video.voiceReferenceSeconds?.min,
    /**
     * The recording has to fit the window the model accepts a voice reference
     * in, or it cannot perform the line at all and the shot falls through to the
     * lip-synced path — which is the one that comes back out of step.
     */
    maxSpokenSeconds: spokenCeilingSeconds(),
    // Measured from the creator's own voice, not assumed.
    charsPerSecond: await voicePace(creator.voice),
    wardrobeFromPhoto: project.wardrobeRefs.length > 0,
    script: project.transcript,
  });

  setProgress(85);

  /**
   * A photo set is silent, and that is enforced here rather than trusted.
   *
   * The writer is told to leave every line empty, and a model that ignores it
   * leaves dialogue on stills — which then shows a script on the card, offers
   * a voice stage that produces narration nobody will hear, and bills for it.
   * Verified against the placeholder writer, which does ignore the rule.
   */
  const photo = project.settings.kind === "photo";
  projects.replaceScenes(
    projectId,
    result.scenes.map((scene) => ({
      title: scene.title,
      spec: scene.spec,
      dialogue: photo ? "" : scene.dialogue,
      durationSeconds: scene.durationSeconds,
    })),
  );

  projects.update(projectId, {
    // Adopt the written title whenever the operator did not choose one. The
    // check used to be equality with the literal default, so a project created
    // with a blank title kept the blank and the page rendered an empty heading.
    title: !project.title.trim() || project.title === "Untitled project" ? result.title : project.title,
    transcript: photo ? "" : result.transcript,
    status: "storyboarded",
  });

  return { sceneCount: result.scenes.length, title: result.title };
};

// ---------------------------------------------------------------------------
// Creator bootstrap — invent a first frame for a creator with no photos
// ---------------------------------------------------------------------------

const creatorBootstrap: JobHandler = async (context) => {
  const { job } = context;
  const creatorId = requireId(job.creatorId, "creatorId");
  const creator = creators.get(creatorId);
  if (!creator) throw new Error("Creator not found");

  const provider = imageProvider();
  const prompt = compileBootstrapPrompt(creator);

  // The only text-to-image call in the app: no references means the adapter
  // takes the t2i path, and this frame becomes the seed everything else
  // conditions on.
  const submit = () =>
    provider.submit({
      prompt,
      aspectRatio: "3:4",
      quality: "high",
      referenceUrls: [],
    });
  const result = await context.awaitTask(await submit(), (h) => provider.poll(h), {
    progressCeiling: 85,
    resubmit: submit,
  });

  const url = result.urls[0];
  const stored = await persistFromUrl(url, `creators/${creatorId}`, `seed-${Date.now()}`);

  creators.addReference({
    creatorId,
    kind: "seed",
    angle: "front",
    remoteUrl: url,
    localPath: stored.relativePath,
    isAnchor: true,
  });

  return { referenceUrl: url, localPath: stored.relativePath };
};

// ---------------------------------------------------------------------------
// Identity sheet — the canonical multi-angle reference set
// ---------------------------------------------------------------------------

/**
 * Generates one shot per canonical angle, each conditioned on the creator's
 * existing anchors. The resulting sheet is both the reviewer-facing proof of
 * identity consistency and the anchor pool that later scene renders draw from:
 * a rear shot in a storyboard pulls the sheet's rear shot as its reference.
 */

/**
 * Reference images the *current* image model can actually read.
 *
 * Placeholder mode writes SVG, which every raster image model rejects — KIE
 * answers `500: File type not supported`. A creator built before the keys were
 * added therefore carries anchors that look fine in the UI and poison every
 * live render, with an error that names the file type but not the cause.
 *
 * Rather than surface that, drop them: an unusable anchor is worth exactly as
 * much as no anchor, and the caller can then re-seed.
 *
 * The check is conditional on the provider, and that matters. Applying it
 * unconditionally broke placeholder mode outright: the mock provider's own SVG
 * output was filtered out as unreadable, so a fresh install with no API keys
 * failed every identity sheet with "this creator has no usable reference
 * images" while two references sat visibly on the page. Placeholder output is
 * exactly what the placeholder provider can read.
 */
function usableReferences<T extends { remoteUrl: string; localPath?: string | null }>(
  refs: T[],
  rasterOnly: boolean,
): T[] {
  if (!rasterOnly) return refs;
  return refs.filter((ref) => {
    const target = `${ref.localPath ?? ""} ${ref.remoteUrl}`.toLowerCase();
    return !target.includes(".svg") && !target.includes("image/svg");
  });
}

/**
 * Replace a creator's unusable placeholder seed with a real one.
 *
 * Reuses the bootstrap prompt — the same path a creator with no photos takes —
 * so a creator made in placeholder mode becomes a working creator on its first
 * live render instead of failing until someone works out why.
 */
async function reseedFromIdentity(
  context: JobContext,
  creatorId: string,
): Promise<string | null> {
  const creator = creators.get(creatorId);
  if (!creator) return null;
  const provider = imageProvider();
  const submit = () =>
    provider.submit({
      prompt: compileBootstrapPrompt(creator),
      aspectRatio: "3:4",
      quality: "high",
      referenceUrls: [],
    });
  const result = await context.awaitTask(await submit(), (h) => provider.poll(h), {
    progressFloor: 2,
    progressCeiling: 20,
    resubmit: submit,
  });
  const url = result.urls[0];
  const stored = await persistFromUrl(url, `creators/${creatorId}`, `seed-${Date.now()}`);
  creators.addReference({
    creatorId,
    kind: "seed",
    angle: "front",
    remoteUrl: url,
    localPath: stored.relativePath,
    isAnchor: true,
  });
  return url;
}

const identitySheet: JobHandler = async (context) => {
  const { job, setProgress } = context;
  const creatorId = requireId(job.creatorId, "creatorId");
  let creator = creators.get(creatorId);
  if (!creator) throw new Error("Creator not found");

  // Two by default; the creator page can ask for any of the others by name.
  const requested =
    (job.input.angles as IdentityAngle[] | undefined) ?? [...DEFAULT_IDENTITY_ANGLES];

  // A photo-less creator has its seed frame generated by a sibling
  // `creator_bootstrap` job queued moments earlier. Wait for it rather than
  // racing it — with concurrency > 1 both are claimed at once.
  let anchors = creator.references.filter((ref) => ref.kind === "seed");
  if (anchors.length === 0 && jobs.isPendingForCreator(creatorId, "creator_bootstrap")) {
    setProgress(2);
    const seeded = await waitForSeedReferences(creatorId);
    if (seeded) {
      creator = seeded;
      anchors = creator.references.filter((ref) => ref.kind === "seed");
    }
  }

  // Anchors written in placeholder mode are SVG and unusable by any live image
  // model. Drop them and mint a real seed rather than failing every angle with
  // "File type not supported". Placeholder mode itself keeps them — they are
  // the only thing it produces.
  const provider = imageProvider();
  const rasterOnly = !provider.acceptsVectorReferences;
  const usable = usableReferences(anchors, rasterOnly);
  if (usable.length === 0 && anchors.length > 0) {
    console.info(
      `[jobs] identity_sheet ${job.id}: creator's references are placeholder output; re-seeding`,
    );
    setProgress(2);
    const seeded = await reseedFromIdentity(context, creatorId);
    if (seeded) {
      creator = creators.get(creatorId) ?? creator;
      anchors = usableReferences(
        creator.references.filter((ref) => ref.kind === "seed"),
        rasterOnly,
      );
    }
  } else {
    anchors = usable;
  }

  if (anchors.length === 0) {
    throw new Error(
      "This creator has no usable reference images. Upload a photo, or regenerate the seed portrait.",
    );
  }

  if (job.input.replace !== false) {
    creators.clearSheet(creatorId);
  }

  // Never trust an old CDN URL for the images that define the face. Refresh
  // them from the durable local copies before spending on sheet generation.
  anchors = await providerReadyCreatorReferences(anchors);
  const anchorUrls = anchors.map((ref) => ref.remoteUrl);
  const produced: Array<{ angle: IdentityAngle; url: string }> = [];
  const failures: Array<{ angle: IdentityAngle; error: string }> = [];

  for (const [index, angle] of requested.entries()) {
    const floor = (index / requested.length) * 100;
    const ceiling = ((index + 1) / requested.length) * 100;
    setProgress(floor);

    try {
      const prompt = compileIdentitySheetPrompt(creator, angle, false);
      const submit = () =>
        provider.submit({
          prompt,
          // Portrait format gives the model the most pixels on the subject.
          aspectRatio: angle === "full_body" ? "9:16" : "3:4",
          quality: "high",
          referenceUrls: anchorUrls,
        });
      const result = await context.awaitTask(await submit(), (h) => provider.poll(h), {
        progressFloor: floor,
        progressCeiling: ceiling,
        resubmit: submit,
      });

      const url = result.urls[0];
      const stored = await persistFromUrl(url, `creators/${creatorId}`, `sheet-${angle}`);

      creators.addReference({
        creatorId,
        kind: "sheet",
        angle,
        remoteUrl: url,
        localPath: stored.relativePath,
        // Sheet shots are selected per-scene by angle, not blanket-anchored,
        // so that a rear shot does not drag a frontal portrait along with it.
        isAnchor: false,
      });
      produced.push({ angle, url });
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);
      /**
       * A content-filter refusal is worth one plain-language retry.
       *
       * The provider refuses outright — the angle simply does not render — and
       * a creator missing their close-up is a creator whose every later scene
       * loses its best face anchor. Observed live: a curvy, "sexy"-register
       * creator rendered a full body fine and had the close-up refused, and
       * the job still reported success, so the whole pipeline ran on half a
       * sheet without anything saying so.
       */
      if (isModeration(message_)) {
        try {
          const retry = compileIdentitySheetPrompt(creator, angle, true);
          const submitPlain = () =>
            provider.submit({
              prompt: retry,
              aspectRatio: angle === "full_body" ? "9:16" : "3:4",
              quality: "high",
              referenceUrls: anchorUrls,
            });
          const result = await context.awaitTask(
            await submitPlain(),
            (h) => provider.poll(h),
            { progressFloor: floor, progressCeiling: ceiling, resubmit: submitPlain },
          );
          const url = result.urls[0];
          const stored = await persistFromUrl(
            url,
            `creators/${creatorId}`,
            `${angle}-${Date.now()}`,
          );
          creators.addReference({
            creatorId,
            kind: "sheet",
            angle,
            remoteUrl: url,
            localPath: stored.relativePath,
            isAnchor: false,
          });
          produced.push({ angle, url });
          continue;
        } catch (retryError) {
          failures.push({
            angle,
            error: `${message_} (plain-language retry also failed: ${
              retryError instanceof Error ? retryError.message : String(retryError)
            })`,
          });
          continue;
        }
      }
      failures.push({ angle, error: message_ });
    }
  }

  if (produced.length === 0) {
    throw new Error(
      `Identity sheet generation failed for every angle. First error: ${failures[0]?.error ?? "unknown"}`,
    );
  }

  creators.update(creatorId, { status: "ready" });

  /**
   * A missing CORE angle is a failure, not a footnote.
   *
   * This used to return success with the failures tucked into the result
   * payload, so a creator shipped with half an identity sheet and nothing in
   * the UI said why. The close-up and the full body are what every later
   * render anchors against; losing one silently is how a project ends up
   * looking almost right and nobody can say what changed.
   */
  const missingCore = (DEFAULT_IDENTITY_ANGLES as readonly IdentityAngle[]).filter(
    (angle) =>
      requested.includes(angle) && !produced.some((item) => item.angle === angle),
  );
  if (missingCore.length > 0) {
    throw new Error(
      `Identity sheet is incomplete — ${missingCore.join(" and ")} did not render. ` +
        `${failures.map((f) => `${f.angle}: ${f.error}`).join("; ")}`,
    );
  }

  return { generated: produced.length, angles: produced.map((p) => p.angle), failures };
};

// ---------------------------------------------------------------------------
// Scene image
// ---------------------------------------------------------------------------


/**
 * The location plate for a scene: generate it once, then reuse it forever.
 *
 * This is the "same place" half of consistency, and it mirrors how the identity
 * sheet handles the "same person" half — render a canonical reference once and
 * feed it back, rather than asking the model to re-imagine the room from words
 * on every shot and hoping it matches.
 *
 * Failure here is deliberately non-fatal. A missing plate costs continuity
 * between shots; failing the render would cost the shot entirely, which is a
 * far worse trade.
 */
async function ensureLocationPlate(
  context: JobContext,
  project: Project,
  scene: Scene,
): Promise<string | null> {
  const key = (scene.spec.locationKey || "").trim();
  if (!key) return null;

  const { plate, created } = plates.ensure({
    projectId: project.id,
    kind: "location",
    key,
    label: key.replace(/_/g, " "),
    description: scene.spec.environment,
  });

  if (plate.remoteUrl) return plate.remoteUrl;

  // Another scene reserved this key and is rendering it right now. Wait rather
  // than paying for a second copy of the same room.
  if (!created) {
    const ready = await waitForPlate(project.id, key);
    return ready?.remoteUrl ?? null;
  }

  try {
    const provider = imageProvider();
    const prompt = compilePlatePrompt(
      plate.description,
      project.settings.globalStyle,
      project.settings.look,
    );
    // The creator's anchors are deliberately NOT passed: a plate's whole value
    // is being empty, and an identity anchor would put a person in it.
    //
    // Photos of the place are a different matter. When the operator has
    // supplied them they are the whole point — "this exact room", not "a room
    // like this" — so the plate is generated against them and every scene set
    // there inherits the match. With none supplied this stays text-to-image,
    // exactly as before.
    const submit = () =>
      provider.submit({
        prompt,
        aspectRatio: project.settings.aspectRatio,
        quality: project.settings.imageQuality,
        referenceUrls: project.backgroundRefs.slice(0, 4),
      });
    const result = await context.awaitTask(await submit(), (h) => provider.poll(h), {
      progressFloor: 4,
      progressCeiling: 18,
      resubmit: submit,
    });

    const url = result.urls[0];
    const stored = await persistFromUrl(url, `projects/${project.id}`, `plate-${key}-${Date.now()}`);
    plates.attachImage(plate.id, url, stored.relativePath);
    return url;
  } catch (error) {
    // Drop the reservation so a later render can try again instead of
    // inheriting a permanently empty plate.
    plates.remove(plate.id);
    console.warn(`[jobs] location plate "${key}" failed — ${message(error)}`);
    return null;
  }
}

/** Poll for a plate a sibling job is generating. */
async function waitForPlate(projectId: string, key: string, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const plate = plates.byKey(projectId, key);
    // Gone means the sibling failed and released it; there is nothing to wait for.
    if (!plate) return null;
    if (plate.remoteUrl) return plate;
  }
  return null;
}


/**
 * The most recent rendered keyframe from an *earlier* scene in the same
 * location, if there is one.
 *
 * The location plate fixes the room in the abstract; this fixes how the room
 * actually came out. Once scene 1 has resolved a plate into a real frame — this
 * counter, lit this way, shot on this lens — scene 2 in the same place should
 * agree with that frame rather than re-interpreting the plate from scratch.
 *
 * Deliberately scoped to the same `locationKey` and to scenes *before* this one.
 * Chaining across a location change would drag the old room into the new one,
 * and chaining forward would make a re-render of scene 1 depend on scene 2.
 *
 * This is not the frame-to-frame chain the identity system avoids: it is one
 * extra reference behind the creator's anchors, not a replacement for them, so
 * a drifted frame cannot pull the person along with it.
 */
function previousSceneInLocation(
  project: Project,
  scene: Scene,
  creatorId: string,
): string | null {
  const key = (scene.spec.locationKey || "").trim();
  if (!key) return null;

  const earlier = projects
    .scenes(project.id)
    .filter((s) => s.index < scene.index && (s.spec.locationKey || "").trim() === key)
    .reverse();

  for (const candidate of earlier) {
    const image = assets.latestForScene(candidate.id, "image", creatorId);
    if (image?.remoteUrl) return image.remoteUrl;
  }
  return null;
}

/**
 * Wait for the first shot in this scene's location before rendering this one.
 *
 * The continuity reference above is only worth having if it exists at the
 * moment the render is submitted, and shots render concurrently — so whichever
 * scenes happened to start first each built the room from the plate alone, and
 * each resolved it differently. A 15-second test came back as two shots of two
 * visibly different corners of the same bedroom, which is exactly the failure
 * this reference was added to prevent; it was simply never there in time.
 *
 * So the scenes in a location are serialised behind the first one: it renders
 * against the plate and establishes the room, everything after it matches the
 * frame rather than re-interpreting the description. Only the lead shot blocks;
 * different locations still render in parallel with each other.
 *
 * Bounded, and gives up rather than failing. If the lead shot errors or its job
 * disappears, waiting forever would strand the whole project — a shot rendered
 * without the reference is worth more than a project that never finishes.
 */
async function waitForLocationLead(
  project: Project,
  scene: Scene,
  creatorId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<string | null> {
  const key = (scene.spec.locationKey || "").trim();
  if (!key) return null;

  const lead = projects
    .scenes(project.id)
    .find((s) => s.index < scene.index && (s.spec.locationKey || "").trim() === key);
  if (!lead) return null;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = previousSceneInLocation(project, scene, creatorId);
    if (ready) return ready;
    // Nothing is coming: the lead is not queued and not running.
    if (!jobs.isPendingForScene(lead.id, "scene_image")) return null;
    if (Date.now() >= deadline) return null;
    await sleep(3000);
  }
}

/**
 * Scene 1 is the appearance master for the whole project.
 *
 * The creator seed remains the sole face authority. The first rendered scene
 * adds what a headshot and prose cannot reliably freeze: the exact way the
 * hair fell in this shoot and the exact realised colour/cut of every garment.
 * Every later scene references the same master rather than chaining from its
 * immediate predecessor, so a small error cannot accumulate across scenes.
 */
function projectAppearanceMaster(
  project: Project,
  scene: Scene,
  creatorId: string,
): Asset | null {
  const lead = projects.scenes(project.id)[0];
  if (!lead || lead.id === scene.id) return null;
  return assets.latestForScene(lead.id, "image", creatorId) ?? null;
}

async function waitForAppearanceMaster(
  project: Project,
  scene: Scene,
  creatorId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<Asset | null> {
  const lead = projects.scenes(project.id)[0];
  if (!lead || lead.id === scene.id) return null;

  const ready = projectAppearanceMaster(project, scene, creatorId);
  if (ready) return ready;
  if (!jobs.isPendingForScene(lead.id, "scene_image", creatorId)) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const frame = projectAppearanceMaster(project, scene, creatorId);
    if (frame) return frame;
    if (!jobs.isPendingForScene(lead.id, "scene_image", creatorId)) return null;
  }
  return null;
}


/**
 * A real photograph of this scene's location, found on the web and cached.
 *
 * The operator can upload one, and when they do it wins. Most of the time they
 * will not, and the app should not need them to: the storyboard already says
 * where the scene happens, which is a search query. A photograph of a real
 * place beats a generated one by a wide margin — it is the difference between
 * a street and *this* street, and it is what stops the subject reading as
 * pasted in front of a backdrop.
 *
 * Cached per project and location key in the plates table, so every scene set
 * in one place is conditioned on the same photograph. That is the same reason
 * the generated plate is cached: continuity is the point.
 *
 * Re-hosted on the provider's own storage rather than linked. Stock hosts block
 * server-to-server fetches — the image model reported "image fetch failed" on a
 * perfectly public URL — and a hotlink can rot between the render and a
 * re-render months later.
 *
 * Best-effort throughout. No photo found, a source down, an upload refused:
 * the scene still has its written description and the generated plate, so a
 * missing photograph costs quality, never the render.
 */
async function ensureSourcedLocationPhoto(
  project: Project,
  scene: Scene,
): Promise<string | null> {
  const key = (scene.spec.locationKey || "").trim();
  if (!key) return null;

  const cacheKey = `photo:${key}`;
  const { plate, created } = plates.ensure({
    projectId: project.id,
    kind: "location",
    key: cacheKey,
    label: `${key.replace(/_/g, " ")} (photo reference)`,
    description: scene.spec.environment,
  });
  if (plate.remoteUrl) return plate.remoteUrl;
  if (!created) {
    const ready = await waitForPlate(project.id, cacheKey);
    return ready?.remoteUrl ?? null;
  }

  try {
    const query = locationSearchQuery(key, scene.spec.environment);
    const photo = await findLocationPhoto(query);
    if (!photo) return null;

    const response = await fetch(photo.url);
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    const hosted = await uploadBase64(bytes, `${key}-${Date.now()}.jpg`, "images/location-refs");

    // Stored with no local copy: the file lives on the provider's storage, and
    // the app never needs to serve this one — it is a render input, not an
    // asset anyone looks at.
    plates.attachImage(plate.id, hosted, null);
    console.info(`[location] ${key}: using "${photo.credit}" (${photo.source}) for "${query}"`);
    return hosted;
  } catch {
    return null;
  }
}

const sceneImage: JobHandler = async (context) => {
  const { job } = context;
  const sceneId = requireId(job.sceneId, "sceneId");
  // The approved id points to a specific previous asset. Clear it as soon as a
  // replacement starts so no direct/internal job path can retain stale consent.
  scenes.clearImageApproval(sceneId);
  const scene = scenes.get(sceneId);
  if (!scene) throw new Error("Scene not found");
  const project = projects.get(scene.projectId);
  if (!project) throw new Error("Project not found");

  // The creator can be overridden per job — that is exactly what a character
  // swap does, leaving the scene spec untouched.
  const creatorId = (job.input.creatorId as string | undefined) ?? project.creatorId;
  const creator = creators.get(creatorId);
  if (!creator) throw new Error("Creator not found");

  const provider = imageProvider();

  /**
   * What defines the place for this shot, in strict order of authority.
   *
   * 1. A shot of this location that has already been rendered. Once the first
   *    scene in a place exists, that frame IS the place — it is how the room
   *    actually came out, at the right camera height, with the creator already
   *    standing in it. Every later scene matches that rather than going back to
   *    the source material, because a photograph re-interpreted a second time
   *    produces a second, subtly different room. This is the whole reason a
   *    30-second piece can hold one location across four shots.
   * 2. A photograph the operator uploaded, or one found for the location.
   *    Establishes the place for the first shot.
   * 3. A generated plate, only when there is no photograph at all — an invented
   *    room is the weakest of the three and costs a render to make.
   *
   * The plate is skipped whenever 1 or 2 exists. It was there to fix the room
   * in the absence of anything real; with something real attached it is a
   * second opinion nobody asked for, and it is not free.
   */
  context.setProgress(4);
  const [uploadedPhotos, wardrobeRefs, styleRefs] = await Promise.all([
    providerReadyContextReferences(project.backgroundRefs, `${project.id}-location`),
    providerReadyContextReferences(project.wardrobeRefs, `${project.id}-wardrobe`),
    providerReadyContextReferences(project.styleRefs, `${project.id}-style`),
  ]);

  // Scene 1 is a styling reference, not an identity replacement. It is named
  // separately in the prompt, and verified creator anchors remain first.
  const appearanceMasterAsset = await waitForAppearanceMaster(project, scene, creatorId);
  const appearanceMaster = appearanceMasterAsset
    ? provider.name === "mock"
      ? appearanceMasterAsset.remoteUrl
      : appearanceMasterAsset.localPath
        ? await providerReadyStoredReference(
            appearanceMasterAsset.localPath,
            `${project.id}-appearance-master`,
          )
        : (() => {
            throw new Error(
              "Scene 1 has no durable local image, so it cannot safely lock appearance. Regenerate scene 1 first.",
            );
          })()
    : null;
  const sourcedPhoto = uploadedPhotos.length
    ? null
    : provider.name === "mock:image"
      ? null
      : await ensureSourcedLocationPhoto(project, scene);

  const locationRefs = uploadedPhotos.length
    ? uploadedPhotos
    : sourcedPhoto
      ? [sourcedPhoto]
      : [];

  const plateUrl = locationRefs.length ? null : await ensureLocationPlate(context, project, scene);

  const durableCreatorReferences = await providerReadyCreatorReferences(
    usableReferences(creator.references, !provider.acceptsVectorReferences),
  );
  const referenceUrls = selectReferences({
    // Same guard as the identity sheet: a placeholder SVG anchor left over from
    // before the keys were added would fail this render with an error naming
    // the file type rather than the cause.
    references: durableCreatorReferences,
    angle: scene.spec.subjectAngle,
    // Plate first, then a previously rendered shot of the same room. The plate
    // is the room's ground truth — generated before anyone is in it, exactly as
    // an operator would build a set before casting it.
    // The location reference is named separately in the prompt, so it must not
    // also arrive here as an unnamed context image — the same picture twice
    // spends a reference slot to say one thing.
    plateUrls: [plateUrl].filter((url): url is string => Boolean(url)),
    continuityRefs: [appearanceMaster].filter((url): url is string => Boolean(url)),
    wardrobeRefs,
    backgroundRefs: locationRefs,
    styleRefs,
  });

  if (referenceUrls.length === 0) {
    throw new Error(
      `Creator "${creator.name}" has no reference images, so identity cannot be preserved. Build the identity sheet first.`,
    );
  }

  const identityReferenceIndices = identityReferencePositions(
    referenceUrls,
    durableCreatorReferences,
  );
  if (identityReferenceIndices.length === 0) {
    throw new Error(
      `Creator "${creator.name}" has no verified seed/anchor image in this render. Re-upload the creator references before trying again.`,
    );
  }

  // Resolve clothing once for the entire project instead of letting each scene
  // independently interpret an outfit. A supplied wardrobe photo still wins.
  const lockedWardrobe =
    projects
      .scenes(project.id)
      .map((candidate) => candidate.spec.wardrobe.trim())
      .find(Boolean) ?? creator.identity.wardrobe;

  // Built after the references, because the prompt has to name which attached
  // image is the outfit and that position is only known once they are chosen.
  const prompt = compileImagePrompt(
    creator,
    scene.spec,
    project.settings.globalStyle,
    project.settings.look,
    wardrobeReferencePosition(referenceUrls, wardrobeRefs),
    false,
    locationReferencePosition(referenceUrls, locationRefs),
    false,
    identityReferenceIndices,
    lockedWardrobe,
    appearanceContinuityReferencePosition(
      referenceUrls,
      [appearanceMaster].filter((url): url is string => Boolean(url)),
    ),
  );
  const appearanceContinuityIndex = appearanceContinuityReferencePosition(
    referenceUrls,
    [appearanceMaster].filter((url): url is string => Boolean(url)),
  );

  const render = (usePrompt: string) => {
    const submit = () =>
      provider.submit({
        prompt: usePrompt,
        aspectRatio: project.settings.aspectRatio,
        quality: project.settings.imageQuality,
        referenceUrls,
      });
    return submit().then((handle) =>
      context.awaitTask(handle, (h) => provider.poll(h), {
        progressCeiling: 90,
        resubmit: submit,
      }),
    );
  };

  /**
   * One plain-language retry when the filter refuses the shot.
   *
   * The identity sheet has had this for a while, for the same reason and the
   * same creators: an emphatic figure description reads as sexual to a content
   * filter, and the provider refuses rather than degrades. Scene renders never
   * got it, so a creator whose sheet had already survived the softened path
   * could still lose every shot in a project to the same wording — which is
   * exactly how a live 15-second run died, on the first and only keyframe.
   *
   * The retry re-words the identity plainly. It does not change who the person
   * is, so a shot that comes back from it is still the same creator.
   */
  const plainPrompt = () =>
    compileImagePrompt(
      creator,
      scene.spec,
      project.settings.globalStyle,
      project.settings.look,
      wardrobeReferencePosition(referenceUrls, wardrobeRefs),
      true,
      locationReferencePosition(referenceUrls, locationRefs),
      false,
      identityReferenceIndices,
      lockedWardrobe,
      appearanceContinuityIndex,
    );

  /**
   * Ask the other model.
   *
   * The prompt and the references go across unchanged — this asks a different
   * vendor, it does not ask the same one differently. Vendors draw the line
   * for fashion in different places, and a wardrobe reference that is ordinary
   * commercial clothing is refused by one and rendered by another. Without
   * this the operator's only options were to abandon the outfit or keep
   * re-rolling the same refusal.
   */
  const renderElsewhere = async (usePrompt: string) => {
    if (!provider.submitAlternate) return null;
    const submit = () =>
      provider.submitAlternate!({
        prompt: usePrompt,
        aspectRatio: project.settings.aspectRatio,
        quality: project.settings.imageQuality,
        referenceUrls,
      });
    const handle = await submit();
    if (!handle) return null;
    return context.awaitTask(handle, (h) => provider.poll(h), {
      progressCeiling: 90,
      resubmit: async () => (await submit()) ?? handle,
    });
  };

  /**
   * Photoreal frame first, garment swapped onto it second.
   *
   * The two models are good at different things and neither is good at both.
   * The primary renders a photograph — grain, pore texture, a room that looks
   * lived in — and is the reason this app's stills do not read as generated.
   * The alternate honours a wardrobe reference the primary will not, but its
   * output is glossier and further from a phone snapshot.
   *
   * So the primary renders the shot with no outfit photo attached at all,
   * which is the version it has no objection to, and the alternate is then
   * used as an *editor* on that frame: change the garment, touch nothing else.
   * The face, the skin, the light and the room all survive from the primary's
   * render, because they are never regenerated — they are pixels the edit is
   * told to leave alone.
   *
   * Costs one extra image per keyframe, and only on scenes with an outfit
   * photo. That is the price of not having to choose between the right clothes
   * and a believable photograph.
   */
  const renderTwoStage = async () => {
    if (!provider.submitAlternate) return null;

    // Stage one: the primary, with the wardrobe reference withheld. Nothing in
    // this request is the thing it refuses or quietly rewrites.
    const withoutWardrobe = referenceUrls.filter((url) => !wardrobeRefs.includes(url));
    if (withoutWardrobe.length === 0) return null;

    const basePrompt = compileImagePrompt(
      creator,
      scene.spec,
      project.settings.globalStyle,
      project.settings.look,
      0,
      false,
      locationReferencePosition(withoutWardrobe, locationRefs),
      false,
      identityReferenceIndices,
      lockedWardrobe,
      appearanceContinuityReferencePosition(withoutWardrobe, [appearanceMaster].filter((u): u is string => Boolean(u))),
    );

    const baseSubmit = () =>
      provider.submit({
        prompt: basePrompt,
        aspectRatio: project.settings.aspectRatio,
        quality: project.settings.imageQuality,
        referenceUrls: withoutWardrobe,
      });
    const base = await baseSubmit().then((handle) =>
      context.awaitTask(handle, (h) => provider.poll(h), {
        progressCeiling: 60,
        resubmit: baseSubmit,
      }),
    );
    if (!base.urls[0]) return null;

    // The edit needs the frame back as something the provider can fetch.
    const stored = await persistFromUrl(
      base.urls[0],
      `projects/${project.id}`,
      `scene-${scene.index + 1}-${creatorId}-base-${Date.now()}`,
    );
    /**
     * The base has to be small enough for the editor to actually read.
     *
     * The editing model caps an input image at 10MB, and the primary's 4K PNG
     * is around 17. Over the cap the model does not report a rejected image —
     * it renders from the prompt alone, which looks like success and returns a
     * completely different photograph. That is exactly what it did: a bright,
     * warm, medium-shot hallway came back dark, re-cropped to full body and
     * wearing a different expression, and every "keep the pose" instruction in
     * the prompt was powerless because there was no frame being preserved.
     *
     * Re-encoding to JPEG costs nothing in the output. The editor's resolution
     * comes from its own quality tier, not from the input — a 1152px base and a
     * 4K base both return the same 4K image — so the base only has to carry
     * enough detail to be matched against, not enough to be reprinted.
     */
    const baseBytes = await sharp(await readAsset(stored.relativePath))
      .resize({ width: EDITOR_BASE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const baseUrl = await provider.uploadImage(
      baseBytes,
      `${scene.id}-base.jpg`,
      "image/jpeg",
    );

    const swap = () =>
      provider.submitAlternate!({
        prompt: garmentSwapPrompt(),
        aspectRatio: project.settings.aspectRatio,
        quality: project.settings.imageQuality,
        referenceUrls: [baseUrl, ...wardrobeRefs],
      });
    const handle = await swap();
    if (!handle) return null;
    return context.awaitTask(handle, (h) => provider.poll(h), {
      progressCeiling: 90,
      resubmit: async () => (await swap()) ?? handle,
    });
  };

  /**
   * An attached outfit photo changes which model should render the shot.
   *
   * The primary model does not always refuse a garment it dislikes — it
   * quietly renders a different, more modest one instead, while reporting
   * success. Verified on the same dress and the same instruction: handed a
   * reference of a halter mini with cut-out sides and told "the subject wears
   * that exact garment, same cut, same neckline", it returned a long-sleeved
   * wrap dress. The alternate model reproduced the reference faithfully.
   *
   * A silent substitution cannot be detected after the fact, so it has to be
   * avoided beforehand: when the operator has gone to the trouble of attaching
   * an outfit, the model that honours outfits renders the shot. The primary
   * still covers everything else, and still catches this one if the alternate
   * fails.
   *
   * The trade-off is real and worth knowing: the alternate holds likeness
   * slightly less well. Attaching an outfit photo is an explicit statement
   * that the outfit is what matters.
   */
  /**
   * The primary renders everything it will render.
   *
   * The two-stage swap exists for garments this model refuses, and only for
   * those. It costs an extra paid image and returns a smaller one — 2K against
   * the primary's 4K — so making it the default for every outfit photo would
   * charge every project for a rescue almost none of them need. An ordinary
   * outfit reference is reproduced by the primary perfectly well.
   */
  /**
   * An outfit photo routes the shot down the swap, full stop.
   *
   * The primary is never shown the garment. That is what makes this
   * deterministic: it cannot refuse a garment it was not sent, and it cannot
   * quietly substitute a tamer one either — both of which it did, on the same
   * reference, on different runs of the same prompt. It renders the
   * photograph, which is the thing it is best at, and the editing model puts
   * the clothes on.
   *
   * Replaced a version that rendered with the outfit first and inspected the
   * result to decide whether to rescue it. That was cheaper on paper and worse
   * in practice: it spent a vision call on every outfit render, and when it
   * judged wrong it either shipped the wrong dress or paid for a rescue it did
   * not need. Scenes with no outfit photo are untouched and still render once,
   * on the primary.
   */
  let result;
  try {
    if (wardrobeRefs.length > 0 && provider.submitAlternate) {
      result = (await renderTwoStage().catch(() => null)) ?? undefined;
    }
    result ??= await render(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isModeration(message)) throw error;
    try {
      result = await render(plainPrompt());
    } catch (retryError) {
      const retryMessage =
        retryError instanceof Error ? retryError.message : String(retryError);
      if (!isModeration(retryMessage)) throw retryError;

      /**
       * Refused twice. With an outfit photo attached the two-stage path is the
       * one worth taking — the primary will still render the *scene*, since it
       * only objects to the garment, so the photograph is rendered without the
       * outfit and the garment edited on afterwards. Without an outfit photo
       * there is no garment to withhold, so the alternate simply renders it.
       */
      const rescued =
        wardrobeRefs.length > 0 && provider.submitAlternate
          ? await renderTwoStage().catch(() => null)
          : null;

      result = rescued ?? (await renderElsewhere(prompt)) ?? undefined;
      if (!result) {
        throw new Error(
          `Both image models refused this shot on content grounds. The wardrobe or ` +
            `pose reference for scene ${scene.index + 1} is being read as adult content. ` +
            `Swap the reference for a less revealing garment, or configure a different ` +
            `model with KIE_IMAGE_FALLBACK_MODEL. Provider said: ${retryMessage}`,
        );
      }
    }
  }

  /**
   * What actually produced the image, as opposed to what was planned.
   *
   * The identity gate below can replace all of it, and the asset's record has
   * to describe the render that happened — a stored prompt that did not make
   * the picture is worse than no stored prompt, because it looks reproducible.
   */
  let rendered = {
    prompt,
    referenceUrls,
    identityReferenceIndices,
    appearanceContinuityIndex,
    subjectAngle: scene.spec.subjectAngle,
    gate: null as string | null,
    supersededUrl: null as string | null,
  };

  /**
   * The identity gate: a wide shot full of people is where the face goes.
   *
   * Two things are true at once in a shot like "{CREATOR} pushes through the
   * cheering crowd", framed extreme wide. The subject is small in frame, so
   * there are few pixels on the face to match the anchors against; and the
   * frame contains other faces, which the model is free to average her toward.
   * The result is a shot that is technically correct and is not the creator —
   * the exact failure the whole identity kit exists to prevent, arriving
   * through composition rather than through a bad prompt.
   *
   * The gate is deliberately deterministic: shot type plus a small word list,
   * no vision call, no judgement. A vision check on every wide shot would cost
   * a request per render to answer a question the storyboard already answers in
   * writing, and would be wrong in ways nobody could predict from the code.
   *
   * It renders a second, tightened variant rather than quietly substituting one
   * up front, and that is the point of calling it a gate: the first render is
   * the shot the storyboard asked for, the second is the intervention, and the
   * asset records both so a reviewer can see that the framing was overridden
   * and why. It costs one extra image on the small number of scenes that trip
   * it. Failure is non-fatal — the original render stands.
   */
  if (needsIdentityTightening(scene.spec)) {
    const tightened = await renderIdentityTightened({
      context,
      project,
      scene,
      creator,
      lockedWardrobe,
      durableCreatorReferences,
      plateUrl,
      appearanceMaster,
      wardrobeRefs,
      locationRefs,
      styleRefs,
    }).catch((error) => {
      console.warn(
        `[jobs] identity gate: tightened retry for scene ${scene.index + 1} failed — ${message(error)}`,
      );
      return null;
    });

    if (tightened?.result.urls[0]) {
      rendered = {
        prompt: tightened.prompt,
        referenceUrls: tightened.referenceUrls,
        identityReferenceIndices: tightened.identityReferenceIndices,
        appearanceContinuityIndex: tightened.appearanceContinuityIndex,
        subjectAngle: IDENTITY_TIGHTENED_ANGLE,
        gate: "identity-tightened",
        supersededUrl: result.urls[0] ?? null,
      };
      result = tightened.result;
    }
  }

  const url = result.urls[0];
  const stored = await persistFromUrl(
    url,
    `projects/${project.id}`,
    `scene-${scene.index + 1}-${creatorId}-${Date.now()}`,
  );

  const asset = assets.create({
    kind: "image",
    projectId: project.id,
    sceneId: scene.id,
    creatorId,
    remoteUrl: url,
    localPath: stored.relativePath,
    prompt: rendered.prompt,
    meta: {
      provider: provider.name,
      referenceCount: rendered.referenceUrls.length,
      identityReferenceIndices: rendered.identityReferenceIndices,
      creatorReferencesRefreshed: provider.name !== "mock",
      wardrobeLocked: lockedWardrobe,
      appearanceContinuityReferenceIndex: rendered.appearanceContinuityIndex,
      appearanceContinuityLocked: rendered.appearanceContinuityIndex > 0,
      subjectAngle: rendered.subjectAngle,
      aspectRatio: project.settings.aspectRatio,
      visualFingerprint: visualFingerprint(scene),
      // Null on every ordinary render, so "was this shot overridden?" is one
      // field rather than an inference from the prompt text.
      gate: rendered.gate,
      ...(rendered.gate
        ? {
            // What the storyboard asked for, kept beside what was rendered.
            gateReason: "wide shot with multiple people in the action",
            gateRequestedAngle: scene.spec.subjectAngle,
            gateSupersededUrl: rendered.supersededUrl,
          }
        : {}),
    },
  });

  return { assetId: asset.id, url, ...(rendered.gate ? { gate: rendered.gate } : {}) };
};

/**
 * Wording that means more than one person is in the shot.
 *
 * A small, literal list rather than anything clever. Prefix-matched on a word
 * boundary so "crowds", "cheering" and "groups" are covered without listing
 * every inflection, and kept short on purpose: every entry here costs a render
 * on the scenes it matches, so a word that is only sometimes about other people
 * does not belong in it.
 */
const MULTIPLE_PEOPLE =
  /\b(crowd|cheer|group|part(?:y|ies)|audience|spectator|onlooker|bystander|passer|people|guests|friends|dancers|queue)/i;

/** Framings where the subject is too small for the face to survive company. */
const WIDE_SHOTS: ShotType[] = ["wide", "extreme_wide"];

/** The angle a tightened retry is forced to: the one that carries the face. */
const IDENTITY_TIGHTENED_ANGLE = "front" as const;

/**
 * Appended verbatim to the compiled prompt on a tightened retry.
 *
 * Added to the end rather than woven into the shot block because it is an
 * override, not a description: it should read as the last word on framing,
 * after everything the storyboard said about it.
 */
const IDENTITY_TIGHTENING = " , tight framing on the subject, subject clearly in foreground";

function needsIdentityTightening(spec: Scene["spec"]): boolean {
  return WIDE_SHOTS.includes(spec.shotType) && MULTIPLE_PEOPLE.test(spec.action);
}

/**
 * Re-render the shot with the subject front-on and the frame pulled in.
 *
 * Everything is recomputed against the forced angle rather than reusing the
 * first render's list, because the angle is what decides which identity-sheet
 * shot is attached — asking for a front-on subject while handing the model a
 * full-body reference would tighten the words and not the picture.
 *
 * Returns null when the tightened list has no verified anchor in it, which is
 * the one case where the retry would be worse than the render it replaces.
 */
async function renderIdentityTightened(input: {
  context: JobContext;
  project: Project;
  scene: Scene;
  creator: Creator;
  lockedWardrobe: string;
  durableCreatorReferences: CreatorReference[];
  plateUrl: string | null;
  appearanceMaster: string | null;
  wardrobeRefs: string[];
  locationRefs: string[];
  styleRefs: string[];
}): Promise<{
  result: TaskResult;
  prompt: string;
  referenceUrls: string[];
  identityReferenceIndices: number[];
  appearanceContinuityIndex: number;
} | null> {
  const { context, project, scene, creator } = input;
  const provider = imageProvider();
  const continuityRefs = [input.appearanceMaster].filter((url): url is string => Boolean(url));

  const referenceUrls = selectReferences({
    references: input.durableCreatorReferences,
    angle: IDENTITY_TIGHTENED_ANGLE,
    plateUrls: [input.plateUrl].filter((url): url is string => Boolean(url)),
    continuityRefs,
    wardrobeRefs: input.wardrobeRefs,
    backgroundRefs: input.locationRefs,
    styleRefs: input.styleRefs,
  });
  const identityReferenceIndices = identityReferencePositions(
    referenceUrls,
    input.durableCreatorReferences,
  );
  if (identityReferenceIndices.length === 0) return null;

  const appearanceContinuityIndex = appearanceContinuityReferencePosition(
    referenceUrls,
    continuityRefs,
  );
  const prompt =
    compileImagePrompt(
      creator,
      { ...scene.spec, subjectAngle: IDENTITY_TIGHTENED_ANGLE },
      project.settings.globalStyle,
      project.settings.look,
      wardrobeReferencePosition(referenceUrls, input.wardrobeRefs),
      false,
      locationReferencePosition(referenceUrls, input.locationRefs),
      false,
      identityReferenceIndices,
      input.lockedWardrobe,
      appearanceContinuityIndex,
    ) + IDENTITY_TIGHTENING;

  const submit = () =>
    provider.submit({
      prompt,
      aspectRatio: project.settings.aspectRatio,
      quality: project.settings.imageQuality,
      referenceUrls,
    });
  const result = await context.awaitTask(await submit(), (h) => provider.poll(h), {
    progressFloor: 90,
    progressCeiling: 96,
    resubmit: submit,
  });

  return {
    result,
    prompt,
    referenceUrls,
    identityReferenceIndices,
    appearanceContinuityIndex,
  };
}

// ---------------------------------------------------------------------------
// Scene video
// ---------------------------------------------------------------------------

/**
 * Image-to-video, then sound.
 *
 * Ordering is the whole point of this stage, and it runs in one job rather than
 * three so that nothing races:
 *
 *   1. The keyframe must already exist — the video model animates a frame whose identity
 *      the image model locked, instead of inventing a face from text.
 *   2. The voice-over must exist *before* the clip is commissioned, because the
 *      narration's real duration is what the clip length is derived from.
 *      Asking for a 5s clip and getting 6.2s of speech is how a reel ends up
 *      cut off mid-word.
 *   3. The clip and the voice are then joined — mouth-driven if a lip-sync
 *      model is available, overlaid if only ffmpeg is, and left side by side if
 *      neither. Every downgrade is recorded on the asset instead of failing.
 */
const sceneVideo: JobHandler = async (context) => {
  const { job, setProgress } = context;
  const sceneId = requireId(job.sceneId, "sceneId");
  const scene = scenes.get(sceneId);
  if (!scene) throw new Error("Scene not found");
  const project = projects.get(scene.projectId);
  if (!project) throw new Error("Project not found");

  // Re-checked here, not only in the render route: a job queued any other way
  // (an older client, a script, a re-queued job after a settings change) must
  // not reach a paid voice or video request either. Read from the scene and
  // project as they are now, not from anything stored on the job.
  const refusal = speechModeGate(scene, project.settings.audioMode);
  if (refusal) throw new Error(refusal);

  const creatorId = (job.input.creatorId as string | undefined) ?? project.creatorId;
  const creator = creators.get(creatorId);
  if (!creator) throw new Error("Creator not found");

  // The keyframe may still be rendering: a bulk render queues image, voice and
  // video together, and with concurrency > 1 this job can be claimed while the
  // scene's own image job is still in flight. Wait for it rather than failing.
  let keyframe = assets.latestForScene(sceneId, "image", creatorId);
  if (!keyframe && jobs.isPendingForScene(sceneId, "scene_image", creatorId)) {
    setProgress(2);
    keyframe = await waitForAsset(sceneId, "image", creatorId, "scene_image");
  }
  if (!keyframe?.remoteUrl) {
    throw new Error("Render this scene's keyframe image before generating video.");
  }

  const hasDialogue = Boolean(scene.dialogue.trim());
  /**
   * Voice-over: the line is narration over a non-speaking shot. The exact take
   * is overlaid whatever the project default, the model never receives the
   * words or the waveform, and nothing re-performs the voice.
   */
  const voiceover = isVoiceover(scene);
  const speechMode = effectiveSpeechMode(scene.spec);
  const audioMode = audioModeForScene(scene, project.settings.audioMode);

  // --- 1. Voice first ------------------------------------------------------
  let voiceAsset = hasDialogue ? assets.latestForScene(sceneId, "audio", creatorId) : null;
  if (voiceAsset?.meta?.voiceFingerprint !== voiceFingerprint(scene)) {
    voiceAsset = null;
  }
  let voiceSeconds: number | null = null;
  let voiceSource: string | null = null;

  if (hasDialogue && !voiceAsset && jobs.isPendingForScene(sceneId, "scene_voice", creatorId)) {
    // A voice job for this scene is queued or running: wait rather than
    // duplicating it. Both stages are enqueued together by the render route.
    voiceAsset = await waitForAsset(sceneId, "audio", creatorId, "scene_voice");
  }

  let voiceError: string | null = null;
  if (hasDialogue && !voiceAsset) {
    // Nothing queued it, so this job owns it.
    setProgress(5);
    try {
      const synthesized = await synthesizeSceneVoice({
        scene,
        projectId: project.id,
        creatorId,
        voice: creator.voice,
        awaitTask: context.awaitTask,
        progressFloor: 5,
        progressCeiling: 25,
        fitSeconds: spokenCeilingSeconds(scene.durationSeconds),
      });
      voiceAsset = synthesized.asset;
      voiceSeconds = synthesized.duration.seconds;
      voiceSource = synthesized.duration.source;
    } catch (error) {
      // The voice service being unavailable should cost this scene its
      // narration, not its picture. Fall back to the storyboard's planned
      // duration and say so on the asset — re-running the voice stage later
      // picks up where this left off.
      voiceError = message(error);
      console.warn(`[jobs] scene_video ${job.id}: voice unavailable — ${voiceError}`);
    }
  } else if (voiceAsset) {
    const measured = await measureVoiceAsset(voiceAsset, scene.dialogue);
    voiceSeconds = measured.seconds;
    voiceSource = measured.source;
  }

  // --- 2. Clip length from the narration, not the storyboard's guess -------
  const provider = videoProvider();
  const planned = scene.durationSeconds;
  // A model that generates the speech itself needs no tail padding, and adding
  // it actively hurts: every second of clip past the end of the line is a
  // second the model fills with invented motion. That is where end-of-clip
  // drift comes from — the subject starts walking off after the last word.
  // The reference-audio path has a usable duration window. Outside it the
  // provider rejects the whole request — a one-second line comes back as
  // "audio duration must be greater than or equal to 1.8", which fails the
  // render outright rather than degrading. So a too-short or too-long take
  // falls back to rendering the clip silent and attaching the voice
  // afterwards, which still delivers the line.
  const window = provider.voiceReferenceSeconds;
  const voiceFitsReference =
    !window ||
    voiceSeconds === null ||
    (voiceSeconds >= window.min && voiceSeconds <= window.max);
  //
  // The native path is also only right for one audio mode. It re-performs the
  // line rather than carrying the recorded file, so choosing "Overlay" (the
  // exact waveform) or "Separate files" and then getting a re-performance
  // makes the setting a lie — and the note shown on the asset literally told
  // people to pick Overlay for that, which did nothing. Those two modes now
  // render the clip without the voice reference so there is something silent
  // to attach the real track to.
  /**
   * Hand the video model the creator's recording and let it perform the line.
   *
   * The name for this path is "native", and the name is what caused the damage:
   * it sounds like the model inventing a voice. It is not. The creator's
   * ElevenLabs take is sent as the voice reference and the model performs *in
   * that voice*, which is why one creator sounded like herself across the eight
   * clips of a 30-second piece.
   *
   * The alternative — render the shot silent and have a separate lip-sync model
   * fit the mouth to the recording afterwards — keeps the exact waveform and has
   * produced a mouth out of step on every single attempt. The evidence either
   * way is one-sided and sits in the asset metadata: every clip anyone has
   * called good is this path, every clip anyone has rejected on sync is the
   * other one.
   *
   * What this path does not preserve is the exact recording: the phrasing and
   * pacing are the model's re-performance, the voice is the creator's. Anyone
   * who needs the literal file has the Overlay audio mode and accepts an
   * approximate mouth with it.
   */
  const ALLOW_MODEL_GENERATED_SPEECH = true;
  const wantsNativeSpeech =
    ALLOW_MODEL_GENERATED_SPEECH && audioMode === "lipsync" && !voiceover;
  /**
   * Why the model was not allowed to perform the line, when it was not.
   *
   * Overrunning the reference window is the one that matters and the one that
   * used to leave no trace: the shot renders silent, a lip-sync pass puts the
   * voice on afterwards, the mouth does not track it, and the asset carried no
   * note explaining any of it. A 15-second single-shot piece hit this with a
   * 15.23s take — over by a quarter of a second.
   */
  const nativeSkippedNote =
    wantsNativeSpeech && provider.speaksFromVoice && voiceAsset && !voiceFitsReference && window
      ? `The narration runs ${round(voiceSeconds ?? 0)}s, outside the ${window.min}-${window.max}s ` +
        `window this model can perform from. The shot was rendered silent and the voice lip-synced ` +
        `on afterwards, which tracks the mouth less closely. Shorten the line for this scene, or ` +
        `split it, to get the model's own performance.`
      : null;
  const speaks =
    !voiceover &&
    Boolean(provider.speaksFromVoice) &&
    Boolean(voiceAsset) &&
    voiceFitsReference &&
    wantsNativeSpeech;
  const tail = speaks ? 0 : config.video.tailPaddingSeconds;
  const wanted = voiceSeconds && voiceSeconds > 0 ? voiceSeconds + tail : planned;
  const clipSeconds = Math.max(
    provider.minClipSeconds,
    Math.min(provider.maxClipSeconds, Math.ceil(wanted)),
  );
  // If the line genuinely cannot fit the model's longest clip, say so on the
  // asset — silently trimming a sentence is the kind of thing nobody notices
  // until it is published.
  const audioOverrunSeconds =
    voiceSeconds && voiceSeconds > clipSeconds ? round(voiceSeconds - clipSeconds) : 0;
  /**
   * An overrun is a sync problem, not just a length one.
   *
   * When the recording outlasts the picture, the lip-sync model stretches the
   * shot to cover the difference, and re-timing the whole clip slides the mouth
   * out of step with the words. It used to be reported as a note about the line
   * being long, which reads as cosmetic; it is the single likeliest cause of a
   * clip whose lips do not match, and says so now.
   */
  const overrunNote = audioOverrunSeconds
    ? `The narration is ${audioOverrunSeconds}s longer than the ${clipSeconds}s this model will ` +
      `render in one shot, so the picture has to be stretched to cover it and the mouth drifts out ` +
      `of sync across the clip. Shorten this scene's line, or split the scene.`
    : null;

  setProgress(30);

  // The voice has to be reachable by the provider, not just on disk, for a
  // model that takes it as a reference.
  const voiceUrl = speaks ? await publishAudio(voiceAsset!) : null;
  const speaking = speaks && Boolean(voiceUrl);

  // Whether the SHOT is a talking head is a different question from whether the
  // model drives it from the voice file. A scene with a line is a talking-head
  // shot in every audio mode — Overlay just attaches the recording afterwards
  // instead of performing it. Conflating the two meant picking Overlay quietly
  // switched the prompt to the silent B-roll branch, so the subject was not
  // even shown speaking and the overlaid voice had nothing to land on.
  //
  // A voice-over scene is the exception: its line is narration, so the shot is
  // compiled as non-speaking motion and the words are withheld from the model.
  const prompt = compileVideoPrompt(scene.spec, project.settings.globalStyle, {
    dialogue: voiceover ? undefined : scene.dialogue,
    speaking: hasDialogue && !voiceover,
    voiceover,
    look: project.settings.look,
  });
  const submitClip = () =>
    provider.submit({
      prompt,
      imageUrls: [keyframe.remoteUrl!],
      durationSeconds: clipSeconds,
      resolution: project.settings.videoResolution,
      aspectRatio: project.settings.aspectRatio,
      ...(speaking && !voiceover ? { voiceUrl: voiceUrl!, dialogue: scene.dialogue } : {}),
    });
  const result = await context.awaitTask(await submitClip(), (h) => provider.poll(h), {
    progressFloor: 30,
    progressCeiling: 75,
    resubmit: submitClip,
  });

  const clipUrl = result.urls[0];
  const clip = await persistFromUrl(
    clipUrl,
    `projects/${project.id}`,
    `scene-${scene.index + 1}-${creatorId}-clip-${Date.now()}`,
  );

  // --- 3. Join picture and sound ------------------------------------------
  setProgress(80);
  // When the video model generated the speech itself the clip already carries
  // synchronised sound. Running lip sync over it would re-render a mouth that
  // is already correct, at full cost, so it is skipped outright.
  const joined = speaking
    ? {
        mode: "native" as const,
        relativePath: clip.relativePath,
        remoteUrl: clipUrl,
        note:
          `The clip was generated from the voice track, so it is already in sync and no ` +
          `lip-sync pass was needed. The delivery is a re-performance of the voice take, ` +
          `not the exact recording. If you need the exact file, mark this scene as voice-over ` +
          `(the presenter is shown not speaking and the recording is attached as-is); Overlay ` +
          `cannot match an on-camera mouth and is refused for on-camera lines.`,
      }
    : await attachAudio({
        context,
        project,
        scene,
        creatorId,
        audioMode,
        clip: { url: clipUrl, relativePath: clip.relativePath },
        voice: voiceAsset,
      });

  /**
   * Cut the dead air off the end before the clip is stored.
   *
   * The provider takes whole seconds, so a 7.1-second line is commissioned as
   * an 8-second clip and the last 0.9s is a person who has stopped talking.
   * Every shot therefore ends on a stall, and a sequence of them stalls at
   * every cut — which is what a 15-second test came back with.
   *
   * Done here rather than by asking for a shorter clip because the length that
   * matters is the one that came back: in lip-sync mode the model re-performs
   * the line and its timing is its own, so only the finished file knows where
   * the speech actually ends.
   *
   * Best-effort by design. Without ffmpeg, or on a clip with nothing to trim,
   * the original stands — a slightly long shot is worth far more than a failed
   * render of one already paid for.
   */
  const trimmedRelative = joined.relativePath
    ? `${joined.relativePath.replace(/\.mp4$/i, "")}-tight.mp4`
    : null;
  const trimmed =
    joined.relativePath && trimmedRelative
      ? await trimTrailingSilence(
          absoluteAssetPath(joined.relativePath),
          absoluteAssetPath(trimmedRelative),
        ).catch(() => null)
      : null;

  const asset = assets.create({
    kind: "video",
    projectId: project.id,
    sceneId: scene.id,
    creatorId,
    // The remote URL still points at the provider's untrimmed file, so it is
    // dropped when a local trim exists: serving one and downloading the other
    // would put the stall back for whoever streams it.
    remoteUrl: trimmed ? null : (joined.remoteUrl ?? clipUrl),
    localPath: trimmed ? trimmedRelative : joined.relativePath,
    prompt,
    meta: {
      provider: provider.name,
      keyframeAssetId: keyframe.id,
      videoFingerprint: videoFingerprint(scene),
      resolution: project.settings.videoResolution,
      trailingSilenceTrimmed: Boolean(trimmed),
      // Timing, so a reviewer can see why the clip is the length it is.
      durationSeconds: clipSeconds,
      plannedDurationSeconds: planned,
      voiceDurationSeconds: voiceSeconds === null ? null : round(voiceSeconds),
      voiceDurationSource: voiceSource,
      audioOverrunSeconds,
      // Non-null when the take was tightened to fit the shot, so a faster read
      // is something the card states rather than something you notice by ear.
      voiceSpeedup: typeof voiceAsset?.meta.speedup === "number" ? voiceAsset.meta.speedup : null,
      // What actually happened to the sound, and why.
      audioMode: joined.mode,
      // The mode this scene asked for after speech mode was applied, and the
      // project default it came from — they differ for a voice-over.
      audioModeRequested: audioMode,
      projectAudioMode: project.settings.audioMode,
      speechMode,
      audioNote: [
        voiceError ? `Voice generation failed (${voiceError}).` : null,
        voiceover && voiceAsset
          ? "Voice-over: the subject was rendered not speaking and the recorded narration is " +
            "attached exactly as recorded."
          : null,
        nativeSkippedNote,
        overrunNote,
        joined.note,
      ]
        .filter(Boolean)
        .join(" ") || null,
      voiceFailed: voiceError !== null,
      voiceAssetId: voiceAsset?.id ?? null,
      silentClipPath: joined.mode === "separate" ? null : clip.relativePath,
    },
  });

  /**
   * Re-cut whenever a clip lands.
   *
   * The cut queued alongside the renders can reach the front of the queue
   * before the last clip finishes, in which case it skips. Re-queueing here
   * means the final one to arrive triggers the assembly, and re-rendering a
   * single shot later refreshes the finished video rather than leaving it
   * stale — the cut costs a file copy, so doing it once too often is free.
   */
  if (!jobs.isPendingForProject(project.id, "project_cut")) {
    jobs.create({ type: "project_cut", projectId: project.id, creatorId });
  }

  return {
    assetId: asset.id,
    url: asset.remoteUrl,
    audioMode: joined.mode,
    durationSeconds: clipSeconds,
    ...(joined.note ? { audioNote: joined.note } : {}),
  };
};

/** Poll for the seed reference produced by a sibling bootstrap job. */
async function waitForSeedReferences(
  creatorId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<ReturnType<typeof creators.get>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = creators.get(creatorId);
    if (current?.references.some((ref) => ref.kind === "seed")) return current;
    if (!jobs.isPendingForCreator(creatorId, "creator_bootstrap")) return current;
    await sleep(2000);
  }
  return creators.get(creatorId);
}

/**
 * Wait for an asset a sibling job is producing.
 *
 * Bulk renders queue image, voice and video for every scene at once. Queue
 * order alone does not sequence them — with concurrency > 1 a later job is
 * claimed while an earlier one is still running — so a stage that depends on
 * another stage's output has to wait for it explicitly.
 *
 * Returns null once the sibling is no longer pending without having produced
 * anything: it failed, or had nothing to do.
 */
async function waitForAsset(
  sceneId: string,
  kind: "image" | "audio",
  creatorId: string,
  jobType: JobType,
  timeoutMs = 15 * 60 * 1000,
): Promise<Asset | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = assets.latestForScene(sceneId, kind, creatorId);
    if (existing) return existing;
    if (!jobs.isPendingForScene(sceneId, jobType, creatorId)) return null;
    await sleep(2000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JoinedAudio {
  relativePath: string;
  remoteUrl: string | null;
  /** Reported, not requested — `native` only ever comes from the video model. */
  mode: AudioOutcome;
  note: string | null;
}

/**
 * Attach the voice track to the clip, degrading one step at a time.
 *
 * lipsync -> mux -> separate. Each step down is reported, never thrown: a
 * missing lip-sync model or a machine without ffmpeg should cost you mouth
 * sync, not the render you already paid for.
 */
async function attachAudio(input: {
  context: JobContext;
  project: Project;
  scene: Scene;
  creatorId: string;
  audioMode: AudioMode;
  clip: { url: string; relativePath: string };
  voice: Asset | null;
}): Promise<JoinedAudio> {
  const { clip, voice, audioMode } = input;
  const asSeparate = (note: string | null): JoinedAudio => ({
    relativePath: clip.relativePath,
    remoteUrl: clip.url,
    mode: "separate",
    note,
  });

  if (!voice) {
    return asSeparate(
      input.scene.dialogue.trim() ? "No voice track available for this scene." : null,
    );
  }
  if (audioMode === "separate") return asSeparate(null);

  const baseName = `scene-${input.scene.index + 1}-${input.creatorId}-final-${Date.now()}`;

  // --- lip sync ------------------------------------------------------------
  if (audioMode === "lipsync") {
    const remoteClip = clip.url;
    if (!isFetchable(remoteClip)) {
      // Mock/data output can never be fetched by a remote lip-sync service. Do
      // this check before publishing the voice so offline tests remain fully
      // offline instead of uploading audio that cannot be used.
      return muxOrSeparate(
        input,
        clip,
        voice,
        baseName,
        "Lip sync needs a public clip URL; this clip is local or mock output.",
      );
    }
    // The lip-sync model fetches both inputs by URL, but a voice provider that
    // returns raw bytes (ElevenLabs) leaves us with a local file and no link.
    // Publish it, rather than losing lip sync over a transport detail.
    const remoteVoice = isFetchable(voice.remoteUrl)
      ? voice.remoteUrl
      : await publishAudio(voice);
    if (!isFetchable(remoteVoice)) {
      // The lip-sync model fetches both inputs by URL. A `data:` URL means one
      // side came from a mock provider, so there is nothing real to sync.
      return muxOrSeparate(
        input,
        clip,
        voice,
        baseName,
        "Lip sync needs both the clip and the voice at public URLs; one was local or mock output.",
      );
    }
    try {
      const provider = lipSyncProvider();
      const submit = () => provider.submit({ videoUrl: remoteClip, audioUrl: remoteVoice! });
      const result = await input.context.awaitTask(await submit(), (h) => provider.poll(h), {
        progressFloor: 80,
        progressCeiling: 96,
        resubmit: submit,
      });
      const url = result.urls[0];
      const stored = await persistFromUrl(url, `projects/${input.project.id}`, baseName);
      return { relativePath: stored.relativePath, remoteUrl: url, mode: "lipsync", note: null };
    } catch (error) {
      return muxOrSeparate(
        input,
        clip,
        voice,
        baseName,
        `Lip sync unavailable (${message(error)}).`,
      );
    }
  }

  return muxOrSeparate(input, clip, voice, baseName, null);
}

async function muxOrSeparate(
  input: { project: Project; scene: Scene },
  clip: { url: string; relativePath: string },
  voice: Asset,
  baseName: string,
  reason: string | null,
): Promise<JoinedAudio> {
  const note = (extra: string) => [reason, extra].filter(Boolean).join(" ");

  if (!voice.localPath) {
    return {
      relativePath: clip.relativePath,
      remoteUrl: clip.url,
      mode: "separate",
      note: note("The voice track has no local file to mux."),
    };
  }
  if (!(await ffmpegAvailable())) {
    return {
      relativePath: clip.relativePath,
      remoteUrl: clip.url,
      mode: "separate",
      note: note("ffmpeg is not installed, so the clip and voice stay separate files."),
    };
  }

  try {
    const outputRelative = `projects/${input.project.id}/${baseName}.mp4`;
    await muxAudioOntoVideo(
      absoluteAssetPath(clip.relativePath),
      absoluteAssetPath(voice.localPath),
      absoluteAssetPath(outputRelative),
    );
    return {
      relativePath: outputRelative,
      // The muxed file only exists locally; there is no provider URL for it.
      remoteUrl: null,
      mode: "mux",
      note: reason,
    };
  } catch (error) {
    return {
      relativePath: clip.relativePath,
      remoteUrl: clip.url,
      mode: "separate",
      note: note(`Muxing failed (${message(error)}).`),
    };
  }
}

/**
 * Make a locally-stored voice track reachable by URL.
 *
 * Returns null rather than throwing: failing to publish costs mouth sync, and
 * the caller already knows how to fall back to muxing or to separate files.
 */
async function publishAudio(voice: Asset): Promise<string | null> {
  if (!voice.localPath) return null;
  try {
    const bytes = await readAsset(voice.localPath);
    const name = voice.localPath.split("/").pop() ?? `voice-${voice.id}.mp3`;
    return await uploadBase64(bytes, name, "audio/voiceover");
  } catch (error) {
    console.warn(`[jobs] could not publish voice track for lip sync: ${message(error)}`);
    return null;
  }
}

function isFetchable(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Scene voiceover
// ---------------------------------------------------------------------------

/**
 * Per-scene narration in the creator's locked voice.
 *
 * The video stage calls the same function, so "render voice" and "render video"
 * can never produce two different takes of the same line. Running this stage on
 * its own is still useful: it is how you audition a script before paying for
 * any video.
 */
const sceneVoice: JobHandler = async (context) => {
  const { job } = context;
  const sceneId = requireId(job.sceneId, "sceneId");
  const scene = scenes.get(sceneId);
  if (!scene) throw new Error("Scene not found");
  if (!scene.dialogue.trim()) {
    return { skipped: true, reason: "Scene has no dialogue" };
  }
  const project = projects.get(scene.projectId);
  if (!project) throw new Error("Project not found");

  const creatorId = (job.input.creatorId as string | undefined) ?? project.creatorId;
  const creator = creators.get(creatorId);
  if (!creator) throw new Error("Creator not found");

  const { asset, duration } = await synthesizeSceneVoice({
    scene,
    projectId: project.id,
    creatorId,
    voice: creator.voice,
    awaitTask: context.awaitTask,
    progressCeiling: 90,
    fitSeconds: spokenCeilingSeconds(scene.durationSeconds),
  });

  return {
    assetId: asset.id,
    url: asset.remoteUrl,
    durationSeconds: round(duration.seconds),
    durationSource: duration.source,
  };
};

// ---------------------------------------------------------------------------

export /**
 * Join the finished shots into the one video the operator asked for.
 *
 * The pipeline renders a shot at a time because the video model tops out at
 * fifteen seconds. Handing back four files is handing back the plumbing: a
 * thirty-second brief has not been delivered until there is a thirty-second
 * video. The player on the project page sequences them for viewing, but the
 * export and the download need a real file.
 *
 * Silently does nothing when a shot is missing — a partial cut is worse than
 * none, because it looks like the finished piece.
 */
const projectCut: JobHandler = async ({ job, setProgress }) => {
  const projectId = requireId(job.projectId, "projectId");
  const project = projects.get(projectId);
  if (!project) throw new Error("Project not found");
  if (project.settings.kind === "photo") return { skipped: true, reason: "Photo set" };

  const scenes_ = projects.scenes(projectId);
  const creatorId = (job.input.creatorId as string | undefined) ?? project.creatorId;

  // Newest clip per scene, in scene order.
  const parts: string[] = [];
  for (const scene of scenes_) {
    const clip = assets.latestForScene(scene.id, "video", creatorId);
    if (!clip?.localPath) {
      return { skipped: true, reason: `Scene ${scene.index + 1} has no clip yet` };
    }
    parts.push(absoluteAssetPath(clip.localPath));
  }
  if (parts.length === 0) return { skipped: true, reason: "No clips" };

  setProgress(40);
  const relative = `projects/${projectId}/final-${creatorId}-${Date.now()}.mp4`;
  const result = await concatVideos(parts, absoluteAssetPath(relative));
  if (!result) {
    return {
      skipped: true,
      reason:
        "ffmpeg is unavailable, so the shots could not be joined. Each shot rendered fine and " +
        "the player still plays them in order.",
    };
  }

  /**
   * Each pass below writes a new file and only the last one is kept.
   *
   * Collected rather than deleted in place because a pass that fails returns
   * the file it was given, and deleting eagerly would then delete the finished
   * video. Previously nothing was collected at all and every scored project
   * left its unscored cut behind — a full-size look-alike of the deliverable,
   * sitting in the project folder, indistinguishable from it by name.
   */
  const superseded: string[] = [];

  /**
   * Last time's cut is superseded too.
   *
   * This job re-runs every time a clip lands, so a four-scene project assembles
   * four times and only the fourth is ever shown — `buildProjectView` takes the
   * newest. The earlier three were kept as assets and as files: three complete
   * copies of a video nobody can reach, at tens of megabytes each, per project.
   * A cut is derived from the clips and can always be rebuilt, so there is
   * nothing in an old one worth the disk.
   */
  const previousCuts = assets
    .forProject(projectId)
    .filter((asset) => asset.kind === "video" && asset.meta?.finalCut === true);

  setProgress(60);
  const roomed = await addRoomTone(project, relative, result);
  if (roomed.localPath !== relative) superseded.push(relative);

  setProgress(75);
  const scored = await addMusic(project, roomed.localPath, roomed);
  if (scored.localPath !== roomed.localPath) superseded.push(roomed.localPath);

  setProgress(90);
  const asset = assets.create({
    kind: "video",
    projectId,
    sceneId: null,
    creatorId,
    remoteUrl: null,
    localPath: scored.localPath,
    prompt: null,
    meta: {
      finalCut: true,
      shots: parts.length,
      bytes: scored.bytes,
      ...(scored.music ? { music: scored.music } : {}),
      ...(roomed.roomTone ? { roomTone: roomed.roomTone } : {}),
    },
  });

  // After the new asset exists, never before: a crash between the two should
  // leave a stale cut on the page rather than no cut at all.
  for (const old of previousCuts) {
    assets.remove(old.id);
    if (old.localPath) superseded.push(old.localPath);
  }
  for (const stale of superseded) {
    await rm(absoluteAssetPath(stale), { force: true });
  }

  return {
    assetId: asset.id,
    shots: parts.length,
    bytes: scored.bytes,
    music: scored.music,
    roomTone: roomed.roomTone,
  };
};




/**
 * How wide the base is sent to the editing model.
 *
 * Comfortably inside the provider's 10MB ceiling as a JPEG, and matched to a
 * size proven to work — the render that first reproduced a garment faithfully
 * used a base this size.
 */
const EDITOR_BASE_WIDTH = 1536;

/**
 * The longest a narration take may be, for a scene of this length.
 *
 * Three ceilings, and the lowest wins. The scene's own planned duration is one
 * of them: a five-second scene whose line takes eight seconds produces an
 * eight-second clip, which is how a video comes back longer than the length
 * that was asked for.
 *
 * The other two are the model's. A clip cannot be longer than the video
 * model renders in one shot, and a recording longer than the window the model
 * accepts a voice reference in cannot be performed by the model at all — it
 * falls through to the lip-synced path, which is the one that comes back out of
 * step.
 *
 * The storyboard writer is given this number so lines are written to fit, and
 * voice synthesis is given the same number so a take that misses it is brought
 * back under rather than left to stretch the picture. Both reading it from here
 * is the point: when they disagreed, the writer aimed at one length and the
 * renderer enforced another.
 */
function spokenCeilingSeconds(sceneSeconds?: number): number {
  const video = videoProvider();
  const modelCeiling = Math.min(
    video.maxClipSeconds,
    video.voiceReferenceSeconds?.max ?? video.maxClipSeconds,
  );
  if (!sceneSeconds || sceneSeconds <= 0) return modelCeiling;
  // Never below the model's own floor: a clip shorter than that cannot be
  // rendered at all, so squeezing a take under it would trade one failure
  // for a worse one.
  return Math.max(video.minClipSeconds, Math.min(modelCeiling, sceneSeconds));
}

/**
 * Put the finished cut in a room, unless the project asked for a dry one.
 *
 * Total in the same way `addMusic` is: every failure returns the untreated cut
 * rather than throwing. The room is the last five percent of a video that has
 * already been paid for shot by shot, and losing the video over it would be a
 * bad trade in every direction.
 *
 * Applied here, to the joined cut, rather than to each clip. Two reasons, and
 * the second is the real one: the audio only gets re-encoded once, and the
 * noise floor is continuous across the joins — a floor applied per clip
 * restarts at every cut, which is audible, and is the opposite of the point.
 */
async function addRoomTone(
  project: Project,
  relative: string,
  cut: { bytes: number },
): Promise<{ localPath: string; bytes: number; roomTone?: Record<string, unknown> }> {
  // Absent means the default, not off: projects created before this existed
  // should still sound like they were recorded somewhere.
  const tone = project.settings.roomTone ?? "light";
  if (tone === "off") return { localPath: relative, bytes: cut.bytes };

  try {
    const treatedRelative = `${relative.replace(/\.mp4$/, "")}-room.mp4`;
    const treated = await applyRoomTone(
      absoluteAssetPath(relative),
      absoluteAssetPath(treatedRelative),
      ROOM_TONE_MIX[tone],
    );
    if (!treated) {
      return {
        localPath: relative,
        bytes: cut.bytes,
        roomTone: { requested: tone, applied: false, reason: "ffmpeg could not treat the audio" },
      };
    }
    return {
      localPath: treatedRelative,
      bytes: treated.bytes,
      roomTone: { requested: tone, applied: true },
    };
  } catch (cause) {
    return {
      localPath: relative,
      bytes: cut.bytes,
      roomTone: {
        requested: tone,
        applied: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

/**
 * Score the finished cut, if the project asked for music.
 *
 * Deliberately total: every failure path returns the unscored video rather
 * than throwing. By the time this runs the operator has paid for every shot in
 * the piece, and losing that over a music bed — a garnish — would be the wrong
 * trade. A failure is reported in the job result instead, so it is visible
 * without being fatal.
 */
async function addMusic(
  project: Project,
  relative: string,
  cut: { bytes: number },
): Promise<{ localPath: string; bytes: number; music?: Record<string, unknown> }> {
  const settings = project.settings.music;
  if (!settings || settings.mood === "off") return { localPath: relative, bytes: cut.bytes };

  try {
    const composed = await composeMusic(settings.mood, project.settings.targetDurationSeconds);
    if (!composed) {
      return {
        localPath: relative,
        bytes: cut.bytes,
        music: { requested: settings.mood, applied: false, reason: "No ElevenLabs key configured" },
      };
    }

    // The bed is a working file, not an asset: it only has meaning mixed into
    // the cut, and keeping it would leave an orphan in the library.
    const bedPath = absoluteAssetPath(`${relative}.music.mp3`);
    await writeFile(bedPath, composed.bytes);

    const scoredRelative = `${relative.replace(/\.mp4$/, "")}-scored.mp4`;
    try {
      const mixed = await mixBackgroundMusic(
        absoluteAssetPath(relative),
        bedPath,
        absoluteAssetPath(scoredRelative),
        settings.level,
      );
      if (!mixed) {
        return {
          localPath: relative,
          bytes: cut.bytes,
          music: { requested: settings.mood, applied: false, reason: "ffmpeg could not mix the bed" },
        };
      }
      return {
        localPath: scoredRelative,
        bytes: mixed.bytes,
        music: { requested: settings.mood, applied: true, level: settings.level },
      };
    } finally {
      await rm(bedPath, { force: true });
    }
  } catch (cause) {
    return {
      localPath: relative,
      bytes: cut.bytes,
      music: {
        requested: settings.mood,
        applied: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

export const handlers: Record<JobType, JobHandler> = {
  storyboard,
  identity_sheet: identitySheet,
  creator_bootstrap: creatorBootstrap,
  scene_image: sceneImage,
  scene_video: sceneVideo,
  scene_voice: sceneVoice,
  project_cut: projectCut,
};

/**
 * Provider wording for a content-filter refusal, which is retryable in kind.
 *
 * Written against what the providers actually say, not what they ought to. The
 * first version listed "content policy", "flagged as sensitive", "safety",
 * "moderation" and "nsfw" — and then a live run was refused with
 *
 *   "The image was filtered out because it violated Google's Generative AI
 *    Prohibited Use policy"
 *
 * which matches none of them: it says "Prohibited Use policy", not "content
 * policy". The retry that exists precisely for this never fired, and the render
 * failed outright. Any new wording that turns up belongs here — a refusal this
 * does not recognise is a refusal nothing recovers from.
 */
function isModeration(message: string): boolean {
  return /flagged as sensitive|content polic|prohibited use|use polic|safety|moderation|nsfw|filtered out|violat/i.test(
    message,
  );
}

function requireId(value: string | null, name: string): string {
  if (!value) throw new Error(`Job is missing ${name}`);
  return value;
}

export type { JobContext };
