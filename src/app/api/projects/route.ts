import { z } from "zod";

import { videoStyleSchema } from "@/lib/video-style-schema";

import { ok, readJson, route } from "@/lib/api";
import { scheduleTick } from "@/lib/jobs/runner";
import { creators, jobs, projects } from "@/lib/repo";
import {
  ASPECT_RATIOS,
  AUDIO_MODES,
  CAPTURE_LOOKS,
  IMAGE_QUALITIES,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_SECONDS,
  MAX_PHOTO_COUNT,
  MUSIC_MOODS,
  PROJECT_KINDS,
  ROOM_TONES,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  // `.default()` only fires when the key is ABSENT, and the form always sends
  // the field — so a blank box produced a project with no name and a page with
  // an empty heading.
  title: z.string().max(120).default("").transform((value) => value.trim() || "Untitled project"),
  prompt: z.string().min(5).max(4000),
  creatorId: z.string().min(1),
  /**
   * A script the operator wrote. Optional — left blank, one is written from the
   * brief. Supplied, it is used verbatim and the shots are built around it.
   */
  transcript: z.string().max(20000).default(""),
  settings: z
    .object({
      kind: z.enum(PROJECT_KINDS).default("video"),
      photoCount: z.number().int().min(1).max(MAX_PHOTO_COUNT).default(4),
      aspectRatio: z.enum(ASPECT_RATIOS).default("9:16"),
      imageQuality: z.enum(IMAGE_QUALITIES).default("high"),
      targetDurationSeconds: z
        .number()
        .int()
        .min(MIN_VIDEO_SECONDS)
        .max(MAX_VIDEO_SECONDS)
        .default(30),
      requestedSceneCount: z.number().int().min(1).max(30).optional(),
      // Accepts the old value so projects saved before this was fixed still
      // load, but there is only one resolution the model will render.
      videoResolution: z
        .enum(["720p", "1080p"])
        .default("720p")
        .transform(() => "720p" as const),
      globalStyle: z.string().max(500).default(""),
      audioMode: z.enum(AUDIO_MODES).default("lipsync"),
      look: z.enum(CAPTURE_LOOKS).default("social"),
      videoStyle: videoStyleSchema.optional(),
      music: z
        .object({
          mood: z.enum(MUSIC_MOODS).default("off"),
          // Bounded well below unity: this bed plays under narration, and a
          // level that can drown the words is not a level worth offering.
          level: z.number().min(0).max(0.6).default(0.18),
        })
        .default({}),
      // Defaults to `light` rather than `off`, which is also what an absent
      // value means downstream — the two have to agree or a project created
      // through the API sounds different from one created through the form.
      roomTone: z.enum(ROOM_TONES).default("light"),
    })
    .default({}),
  backgroundRefs: z.array(z.string()).max(6).default([]),
  styleRefs: z.array(z.string()).max(6).default([]),
  wardrobeRefs: z.array(z.string()).max(6).default([]),
  /** Generate the storyboard immediately. */
  autoStoryboard: z.boolean().default(true),
  /**
   * Legacy/internal escape hatch. The safe public default is review mode:
   * writing a storyboard must never silently start billable media jobs.
   */
  autoRender: z.boolean().default(false).transform(() => false),
});

export const GET = route(async () =>
  ok({
    projects: projects.list().map((project) => ({
      ...project,
      creatorName: creators.get(project.creatorId)?.name ?? "(deleted creator)",
    })),
  }),
);

export const POST = route(async (request: Request) => {
  const body = createSchema.parse(await readJson(request));
  if (!creators.get(body.creatorId)) {
    return ok({ error: "Creator not found" }, 404);
  }

  const project = projects.create({
    title: body.title,
    prompt: body.prompt,
    creatorId: body.creatorId,
    settings: body.settings,
    transcript: body.transcript,
    backgroundRefs: body.backgroundRefs,
    styleRefs: body.styleRefs,
    wardrobeRefs: body.wardrobeRefs,
  });

  if (body.autoStoryboard) {
    jobs.create({
      type: "storyboard",
      projectId: project.id,
      creatorId: body.creatorId,
      payload: {},
    });
    scheduleTick();
  }

  return ok({ project: projects.get(project.id) }, 201);
});
