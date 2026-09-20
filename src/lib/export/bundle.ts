import path from "node:path";

import { createZip } from "@/lib/export/zip";
import { substituteSubjectWithName } from "@/lib/prompting";
import { assets, creators, projects } from "@/lib/repo";
import { readAsset } from "@/lib/storage";
import type { Asset, Scene } from "@/lib/types";

/**
 * Export bundle.
 *
 * A reviewer should be able to download one file and have everything the POC
 * claims: the rendered assets, the transcript, the shot list, and — critically
 * — the exact prompts used, so results are auditable and reproducible rather
 * than something we assert.
 */

export async function buildProjectBundle(projectId: string): Promise<{
  fileName: string;
  data: Buffer;
}> {
  const project = projects.get(projectId);
  if (!project) throw new Error("Project not found");
  const creator = creators.get(project.creatorId);

  const projectAssets = assets.forProject(projectId);
  const entries: Array<{ name: string; data: Buffer }> = [];

  // --- media ---------------------------------------------------------------
  const folderFor: Record<Asset["kind"], string> = {
    image: "images",
    video: "video",
    audio: "audio",
  };

  for (const asset of projectAssets) {
    if (!asset.localPath) continue;
    try {
      const bytes = await readAsset(asset.localPath);
      const sceneIndex = project.scenes.findIndex((s) => s.id === asset.sceneId);
      const label =
        sceneIndex >= 0 ? `scene-${String(sceneIndex + 1).padStart(2, "0")}` : "project";
      const creatorTag = asset.creatorId && asset.creatorId !== project.creatorId
        ? `-${asset.creatorId}`
        : "";
      entries.push({
        name: `${folderFor[asset.kind]}/${label}${creatorTag}-${asset.id}${path.extname(asset.localPath)}`,
        data: bytes,
      });
    } catch {
      // A missing local mirror should not sink the whole export.
    }
  }

  // --- text deliverables ---------------------------------------------------
  const creatorName = creator?.name ?? "Creator";

  entries.push({
    name: "transcript.txt",
    data: Buffer.from(
      [`${project.title}`, "", project.transcript || "(not generated yet)", ""].join("\n"),
      "utf8",
    ),
  });

  entries.push({
    name: "storyboard.md",
    data: Buffer.from(renderStoryboardMarkdown(project, creatorName), "utf8"),
  });

  entries.push({
    name: "shot-list.csv",
    data: Buffer.from(renderShotListCsv(project.scenes, creatorName), "utf8"),
  });

  entries.push({
    name: "prompts.json",
    data: Buffer.from(
      JSON.stringify(
        projectAssets.map((asset) => ({
          assetId: asset.id,
          kind: asset.kind,
          sceneId: asset.sceneId,
          creatorId: asset.creatorId,
          prompt: asset.prompt,
          meta: asset.meta,
          createdAt: asset.createdAt,
        })),
        null,
        2,
      ),
      "utf8",
    ),
  });

  entries.push({
    name: "project.json",
    data: Buffer.from(
      JSON.stringify(
        {
          project: {
            id: project.id,
            title: project.title,
            brief: project.prompt,
            settings: project.settings,
            status: project.status,
          },
          creator: creator
            ? {
                id: creator.id,
                name: creator.name,
                category: creator.category,
                persona: creator.persona,
                identity: creator.identity,
                voice: creator.voice,
              }
            : null,
          scenes: project.scenes,
        },
        null,
        2,
      ),
      "utf8",
    ),
  });

  entries.push({ name: "README.txt", data: Buffer.from(bundleReadme(project.title), "utf8") });

  const safeTitle = project.title.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 48) || "project";
  return { fileName: `${safeTitle}-${project.id}.zip`, data: createZip(entries) };
}

function renderStoryboardMarkdown(
  project: { title: string; prompt: string; transcript: string; scenes: Scene[] },
  creatorName: string,
): string {
  const lines: string[] = [
    `# ${project.title}`,
    "",
    `**Brief:** ${project.prompt}`,
    `**Creator:** ${creatorName}`,
    "",
    "## Transcript",
    "",
    project.transcript || "_(not generated yet)_",
    "",
    "## Storyboard",
    "",
  ];

  for (const scene of project.scenes) {
    lines.push(
      `### Scene ${scene.index + 1} — ${scene.title} (${scene.durationSeconds}s)`,
      "",
      `- **Shot:** ${scene.spec.shotType.replace(/_/g, " ")}`,
      `- **Camera:** ${scene.spec.cameraMove.replace(/_/g, " ")}`,
      `- **Subject angle:** ${scene.spec.subjectAngle.replace(/_/g, " ")}`,
      `- **Action:** ${substituteSubjectWithName(scene.spec.action, creatorName)}`,
      `- **Expression:** ${scene.spec.facialExpression}`,
      `- **Pose:** ${scene.spec.pose}`,
      `- **Wardrobe:** ${scene.spec.wardrobe || "(creator default)"}`,
      `- **Environment:** ${scene.spec.environment}`,
      `- **Lighting:** ${scene.spec.lighting}`,
      `- **Mood:** ${scene.spec.mood}`,
      `- **Motion:** ${substituteSubjectWithName(scene.spec.motion, creatorName)}`,
      "",
      `**Dialogue:** ${scene.dialogue || "_(silent)_"}`,
      "",
    );
  }
  return lines.join("\n");
}

function renderShotListCsv(scenes: Scene[], creatorName: string): string {
  const header = [
    "scene",
    "title",
    "duration_s",
    "shot_type",
    "camera_move",
    "subject_angle",
    "action",
    "expression",
    "pose",
    "wardrobe",
    "environment",
    "lighting",
    "mood",
    "dialogue",
  ];
  const rows = scenes.map((scene) =>
    [
      String(scene.index + 1),
      scene.title,
      String(scene.durationSeconds),
      scene.spec.shotType,
      scene.spec.cameraMove,
      scene.spec.subjectAngle,
      substituteSubjectWithName(scene.spec.action, creatorName),
      scene.spec.facialExpression,
      scene.spec.pose,
      scene.spec.wardrobe,
      scene.spec.environment,
      scene.spec.lighting,
      scene.spec.mood,
      scene.dialogue,
    ].map(csvCell),
  );
  return [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

function csvCell(value: string): string {
  const needsQuoting = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

function bundleReadme(title: string): string {
  return [
    `${title} — export bundle`,
    "",
    "Contents",
    "  images/        Rendered keyframes, one or more per scene.",
    "  video/         Generated clips. When lip sync or muxing ran, these already",
    "                 carry the voice track; otherwise they are silent and pair",
    "                 with the matching file in audio/.",
    "  audio/         Per-scene voice-over in the creator's locked voice.",
    "  transcript.txt Full narration script.",
    "  storyboard.md  Scene-by-scene shot list with camera, action and dialogue.",
    "  shot-list.csv  The same shot list, spreadsheet-friendly.",
    "  prompts.json   The exact compiled prompt used for every asset.",
    "  project.json   Full project + creator identity kit, for reproduction.",
    "",
    "Assets whose filename carries a creator id other than the project's own",
    "creator come from a character-swap render of the same scene.",
    "",
    "Every clip's entry in prompts.json records how its sound was handled",
    "(meta.audioMode: lipsync / mux / separate), the measured length of the",
    "narration it was cut to, and — when a step was skipped — why",
    "(meta.audioNote).",
    "",
  ].join("\n");
}
