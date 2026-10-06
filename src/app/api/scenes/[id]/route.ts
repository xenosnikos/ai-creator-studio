import { z } from "zod";

import { fail, ok, readJson, route } from "@/lib/api";
import { scenes } from "@/lib/repo";
import { CAMERA_MOVES, IDENTITY_ANGLES, SHOT_TYPES, SPEECH_MODES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const specSchema = z.object({
  // Optional on the wire: editing a shot should not require the caller to
  // restate which location it is in. Falls back to the scene's current key.
  locationKey: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  shotType: z.enum(SHOT_TYPES),
  cameraMove: z.enum(CAMERA_MOVES),
  subjectAngle: z.enum(IDENTITY_ANGLES),
  action: z.string(),
  facialExpression: z.string(),
  pose: z.string(),
  wardrobe: z.string(),
  environment: z.string(),
  lighting: z.string(),
  mood: z.string(),
  styleNotes: z.string(),
  motion: z.string(),
  // Optional on the wire like locationKey: an edit that does not mention it
  // keeps the scene's current mode rather than resetting it.
  speechMode: z.enum(SPEECH_MODES).optional(),
});

const patchSchema = z.object({
  title: z.string().max(120).optional(),
  dialogue: z.string().max(2000).optional(),
  durationSeconds: z.number().min(3).max(15).optional(),
  spec: specSchema.optional(),
});

export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const scene = scenes.get(id);
  return scene ? ok({ scene }) : fail("Scene not found", 404);
});

/** Manual instruction control: edit any shot field directly. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const patch = patchSchema.parse(await readJson(request));
  const current = scenes.get(id);
  if (!current) return fail("Scene not found", 404);

  // Keep the shot in the location it was already in unless the caller moves it
  // deliberately — otherwise editing an expression would quietly detach the
  // scene from its location plate.
  const speechMode = patch.spec?.speechMode ?? current.spec.speechMode;
  const spec = patch.spec
    ? {
        ...patch.spec,
        locationKey: patch.spec.locationKey ?? current.spec.locationKey,
        // Only written when set, so a legacy scene stays byte-identical.
        ...(speechMode ? { speechMode } : {}),
      }
    : undefined;

  const scene = scenes.update(id, { ...patch, spec });
  return scene ? ok({ scene }) : fail("Scene not found", 404);
});
