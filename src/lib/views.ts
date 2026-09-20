import { substituteSubjectWithName } from "@/lib/prompting";
import { assets, creators, jobs, projects } from "@/lib/repo";
import { publicUrlFor } from "@/lib/storage";
import { videoFingerprint, visualFingerprint, voiceFingerprint } from "@/lib/scene-fingerprint";
import type { Asset, CreatorWithRefs, Job, Project, Scene } from "@/lib/types";

/**
 * View models.
 *
 * The UI needs assets resolved per scene and per creator (so a character swap
 * can be shown side by side), and every asset needs a locally-served URL rather
 * than an expiring provider one. Assembling that here keeps the React
 * components free of data plumbing.
 */

export interface AssetView {
  id: string;
  kind: Asset["kind"];
  url: string | null;
  remoteUrl: string | null;
  prompt: string | null;
  creatorId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** The three things a scene is made of, in the order they have to happen. */
export type SceneStage = "image" | "voice" | "video";

export type StageState =
  | "done"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  /** Nothing has been asked for yet. */
  | "empty"
  /** Cannot run yet — a clip needs its keyframe, a voice needs a line. */
  | "blocked";

export interface StageStatus {
  state: StageState;
  /** 0..100 while running. */
  progress: number;
  /** Present when `failed`. */
  error: string | null;
  /** Why it is blocked, in words a user can act on. */
  blockedReason: string | null;
}

export interface SceneView {
  id: string;
  index: number;
  title: string;
  dialogue: string;
  durationSeconds: number;
  spec: Scene["spec"];
  /** Action / motion with `{CREATOR}` replaced by the creator's name. */
  readableAction: string;
  readableMotion: string;
  image: AssetView | null;
  /** True only when the operator approved this exact newest image asset. */
  stillApproved: boolean;
  video: AssetView | null;
  audio: AssetView | null;
  /**
   * What state each stage is in, resolved server-side.
   *
   * The UI used to infer this from asset presence alone, which cannot tell
   * "not started" from "failed" from "running" — so a scene that errored looked
   * exactly like one nobody had rendered yet, and the only way to find out was
   * to read the job feed and match it up by eye.
   */
  status: Record<SceneStage, StageStatus>;
}

export interface ProjectView {
  project: Project;
  /** The joined video, once every shot is in. Null until then. */
  finalCut: { url: string; bytes: number; audio: string | null } | null;
  creator: CreatorWithRefs | null;
  scenes: SceneView[];
  /** Renders of these scenes made with a *different* creator (swap results). */
  swapCreators: Array<{ creator: CreatorWithRefs; scenes: SceneView[] }>;
  jobs: Job[];
  totals: { images: number; videos: number; audio: number };
}

function toAssetView(asset: Asset | null): AssetView | null {
  if (!asset) return null;
  return {
    id: asset.id,
    kind: asset.kind,
    url: publicUrlFor(asset.localPath) ?? asset.remoteUrl,
    remoteUrl: asset.remoteUrl,
    prompt: asset.prompt,
    creatorId: asset.creatorId,
    meta: asset.meta,
    createdAt: asset.createdAt,
  };
}

const STAGE_JOB_TYPE: Record<SceneStage, Job["type"]> = {
  image: "scene_image",
  voice: "scene_voice",
  video: "scene_video",
};

const IDLE: StageStatus = { state: "empty", progress: 0, error: null, blockedReason: null };

/**
 * Resolve one stage of one scene, from the most recent attempt.
 *
 * Everything keys off the latest job rather than off asset presence, and the
 * order matters. Checking "does an asset exist" first looked reasonable and was
 * wrong: re-rendering a finished scene and having it fail left the stage
 * reading `done`, because the *previous* run's asset was still sitting there.
 * The operator got a green tick for a render that had just 401'd.
 *
 * So a failure outranks a stale asset. The old asset still shows in the
 * thumbnail — it is the newest thing that exists — but the stage reports what
 * actually happened last, and a later success clears it because the latest job
 * is then a successful one.
 */
function stageStatusFor(
  sceneJobs: Job[],
  stage: SceneStage,
  hasAsset: boolean,
  blockedReason: string | null,
): StageStatus {
  // `jobs.forProject` returns newest first, so the first match is the latest.
  const latest = sceneJobs.find((job) => job.type === STAGE_JOB_TYPE[stage]) ?? null;

  if (latest?.status === "running" || latest?.status === "queued") {
    return {
      state: latest.status,
      progress: latest.progress,
      error: null,
      blockedReason: null,
    };
  }
  if (latest?.status === "failed") {
    return { ...IDLE, state: "failed", error: latest.error };
  }
  if (hasAsset) return { ...IDLE, state: "done" };
  if (latest?.status === "cancelled") return { ...IDLE, state: "cancelled" };
  if (blockedReason) return { ...IDLE, state: "blocked", blockedReason };
  return IDLE;
}

function sceneViewsFor(
  scenes: Scene[],
  creatorId: string,
  creatorName: string,
  projectJobs: Job[],
): SceneView[] {
  return scenes.map((scene) => {
    const image = toAssetView(assets.latestForScene(scene.id, "image", creatorId));
    const video = toAssetView(assets.latestForScene(scene.id, "video", creatorId));
    const audio = toAssetView(assets.latestForScene(scene.id, "audio", creatorId));
    const sceneJobs = projectJobs.filter((job) => job.sceneId === scene.id);
    const speaks = scene.dialogue.trim().length > 0;
    const imageMatchesScene = Boolean(
      image && image.meta?.visualFingerprint === visualFingerprint(scene),
    );
    const voiceMatchesScene = Boolean(
      audio && audio.meta?.voiceFingerprint === voiceFingerprint(scene),
    );
    const stillApproved = Boolean(
      imageMatchesScene && image && scene.approvedImageAssetId === image.id,
    );
    const videoMatchesStill = Boolean(
      video &&
        image &&
        video.meta?.keyframeAssetId === image.id &&
        video.meta?.videoFingerprint === videoFingerprint(scene),
    );

    return {
      id: scene.id,
      index: scene.index,
      title: scene.title,
      dialogue: scene.dialogue,
      durationSeconds: scene.durationSeconds,
      spec: scene.spec,
      readableAction: substituteSubjectWithName(scene.spec.action, creatorName),
      readableMotion: substituteSubjectWithName(scene.spec.motion, creatorName),
      image,
      stillApproved,
      video,
      audio,
      status: {
        image: stageStatusFor(sceneJobs, "image", imageMatchesScene, null),
        voice: stageStatusFor(
          sceneJobs,
          "voice",
          voiceMatchesScene,
          !speaks
            ? "This scene has no line — it is silent B-roll."
            : stillApproved
              ? null
              : "Approve the current preview still first.",
        ),
        video: stageStatusFor(
          sceneJobs,
          "video",
          videoMatchesStill,
          !image
            ? "Needs its preview still first."
            : stillApproved
              ? null
              : "Approve the current preview still first.",
        ),
      },
    };
  });
}

export function buildProjectView(projectId: string): ProjectView | null {
  const project = projects.get(projectId);
  if (!project) return null;

  const creator = creators.get(project.creatorId);
  const creatorName = creator?.name ?? "the creator";
  const projectAssets = assets.forProject(projectId);
  const projectJobs = jobs.forProject(projectId);

  // Any creator that has rendered assets on this project but is not the current
  // creator is a swap result — surface it so the two can be compared directly.
  const otherCreatorIds = Array.from(
    new Set(
      projectAssets
        .map((asset) => asset.creatorId)
        .filter((id): id is string => Boolean(id) && id !== project.creatorId),
    ),
  );

  const swapCreators = otherCreatorIds
    .map((id) => creators.get(id))
    .filter((c): c is CreatorWithRefs => c !== null)
    .map((c) => ({
      creator: c,
      scenes: sceneViewsFor(project.scenes, c.id, c.name, projectJobs),
    }));

  return {
    project,
    creator,
    scenes: sceneViewsFor(project.scenes, project.creatorId, creatorName, projectJobs),
    swapCreators,
    // The assembled cut, if one exists. Marked in asset meta rather than by
    // having no sceneId, so a future project-level asset cannot be mistaken
    // for it.
    finalCut: (() => {
      const cut = projectAssets
        .filter((asset) => asset.kind === "video" && asset.meta?.finalCut === true)
        .at(-1);
      const url = cut ? publicUrlFor(cut.localPath) : null;
      if (!url) return null;
      return {
        url,
        bytes: Number(cut!.meta?.bytes ?? 0),
        /**
         * What was done to the sound, in the operator's words.
         *
         * Both treatments are deliberately non-fatal — a bed that could not be
         * composed or a room that ffmpeg could not apply leaves the cut intact
         * and records why. Without surfacing that, "non-fatal" means "silently
         * did not happen", and the only place the reason existed was a JSON
         * blob in the jobs table.
         */
        audio: audioSummary(cut!.meta),
      };
    })(),
    jobs: projectJobs,
    totals: {
      images: projectAssets.filter((a) => a.kind === "image").length,
      videos: projectAssets.filter((a) => a.kind === "video").length,
      audio: projectAssets.filter((a) => a.kind === "audio").length,
    },
  };
}

export interface CreatorView {
  creator: CreatorWithRefs;
  seedRefs: Array<{ id: string; url: string | null; isAnchor: boolean }>;
  sheet: Array<{ id: string; angle: string | null; url: string | null }>;
  jobs: Job[];
  /**
   * How many projects go with this creator if they are deleted.
   *
   * Carried so the delete confirmation can name a number. "Every project made
   * with them is deleted too" is true but easy to skim past; "and 11 projects"
   * is the part that stops someone mid-click.
   */
  projectCount: number;
}

export function buildCreatorView(creatorId: string): CreatorView | null {
  const creator = creators.get(creatorId);
  if (!creator) return null;
  return {
    projectCount: projects.list().filter((project) => project.creatorId === creatorId).length,
    creator,
    seedRefs: creator.references
      .filter((ref) => ref.kind === "seed")
      .map((ref) => ({
        id: ref.id,
        url: publicUrlFor(ref.localPath) ?? ref.remoteUrl,
        isAnchor: ref.isAnchor,
      })),
    sheet: creator.references
      .filter((ref) => ref.kind === "sheet")
      .map((ref) => ({
        id: ref.id,
        angle: ref.angle,
        url: publicUrlFor(ref.localPath) ?? ref.remoteUrl,
      })),
    jobs: jobs.forCreator(creatorId),
  };
}

/**
 * One line describing what happened to the finished cut's sound.
 *
 * Reads the record the cut job left behind rather than the project's settings:
 * the settings say what was asked for, and the meta says what was delivered.
 * When those differ — no ElevenLabs key, ffmpeg unavailable — the difference is
 * the thing worth showing.
 */
function audioSummary(meta: Record<string, unknown> | undefined): string | null {
  const parts: string[] = [];

  const room = meta?.roomTone as { requested?: string; applied?: boolean; reason?: string } | undefined;
  if (room?.applied) parts.push(room.requested === "room" ? "roomy space" : "light room sound");
  else if (room?.requested) parts.push(`no room sound (${room.reason ?? "not applied"})`);

  const music = meta?.music as { requested?: string; applied?: boolean; reason?: string } | undefined;
  if (music?.applied) parts.push(`${music.requested} music, ducked under the voice`);
  else if (music?.requested && music.requested !== "off") {
    parts.push(`no music (${music.reason ?? "not applied"})`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
