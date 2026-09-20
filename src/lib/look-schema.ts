import { z } from "zod";

import {
  AGE_BANDS,
  APPEALS,
  BODY_TYPES,
  BUSTS,
  EYE_COLOURS,
  FACE_SHAPES,
  HAIR_COLOURS,
  HAIR_LENGTHS,
  HEIGHTS,
  HIPS,
  LOOK_STYLES,
  SEXES,
  SKIN_TONES,
} from "@/lib/look";

/**
 * Request validation for the structured appearance picks.
 *
 * Kept apart from `look.ts` so the option lists stay importable by client
 * components without pulling zod into the browser bundle.
 */
export const lookSchema = z.object({
  sex: z.enum(SEXES).optional(),
  ageBand: z.enum(AGE_BANDS).optional(),
  bodyType: z.enum(BODY_TYPES).optional(),
  bust: z.enum(BUSTS).optional(),
  hips: z.enum(HIPS).optional(),
  height: z.enum(HEIGHTS).optional(),
  faceShape: z.enum(FACE_SHAPES).optional(),
  skinTone: z.enum(SKIN_TONES).optional(),
  hairColour: z.enum(HAIR_COLOURS).optional(),
  hairLength: z.enum(HAIR_LENGTHS).optional(),
  eyeColour: z.enum(EYE_COLOURS).optional(),
  style: z.enum(LOOK_STYLES).optional(),
  appeal: z.enum(APPEALS).optional(),
});
