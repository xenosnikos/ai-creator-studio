import { z } from "zod";

import { videoStyleSchema } from "@/lib/video-style-schema";

import { fail, ok, readJson, route } from "@/lib/api";
import { projects } from "@/lib/repo";
import {
  ASPECT_RATIOS,
  AUDIO_MODES,
  CAPTURE_LOOKS,
  IMAGE_QUALITIES,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_SECONDS,
  MAX_PHOTO_COUNT,
  PROJECT_KINDS,
} from "@/lib/types";
import { removeAssetFolder } from "@/lib/storage";
import { buildProjectView } from "@/lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  title: z.string().max(120).optional(),
  prompt: z.string().max(4000).optional(),
  transcript: z.string().max(20000).optional(),
  creatorId: z.string().optional(),
  settings: z
    .object({
      kind: z.enum(PROJECT_KINDS).default("video"),
      photoCount: z.number().int().min(1).max(MAX_PHOTO_COUNT).default(4),
      aspectRatio: z.enum(ASPECT_RATIOS),
      imageQuality: z.enum(IMAGE_QUALITIES),
      targetDurationSeconds: z.number().int().min(MIN_VIDEO_SECONDS).max(MAX_VIDEO_SECONDS),
      requestedSceneCount: z.number().int().min(1).max(30).optional(),
      videoResolution: z
        .enum(["720p", "1080p"])
        .default("720p")
        .transform(() => "720p" as const),
      globalStyle: z.string().max(500),
      audioMode: z.enum(AUDIO_MODES).default("lipsync"),
      look: z.enum(CAPTURE_LOOKS).default("social"),
      videoStyle: videoStyleSchema.optional(),
    })
    .optional(),
  backgroundRefs: z.array(z.string()).max(6).optional(),
  styleRefs: z.array(z.string()).max(6).optional(),
  wardrobeRefs: z.array(z.string()).max(6).optional(),
});

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const view = buildProjectView(id);
  return view ? ok(view) : fail("Project not found", 404);
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const patch = patchSchema.parse(await readJson(request));
  if (
    patch.prompt !== undefined ||
    patch.transcript !== undefined ||
    patch.creatorId !== undefined ||
    patch.settings !== undefined ||
    patch.backgroundRefs !== undefined ||
    patch.styleRefs !== undefined ||
    patch.wardrobeRefs !== undefined
  ) {
    projects.clearStoryboardApproval(id);
  }
  const updated = projects.update(id, patch);
  if (!updated) return fail("Project not found", 404);
  return ok(buildProjectView(id));
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  projects.remove(id);
  // The rows cascade; the files do not. Everything this project rendered lives
  // in one folder named after it, so the folder goes with the project.
  await removeAssetFolder(`projects/${id}`);
  return ok({ deleted: true });
});
