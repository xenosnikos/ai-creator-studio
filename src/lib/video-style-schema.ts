import { z } from "zod";

import {
  ENDINGS,
  ENERGIES,
  HOOKS,
  OUTFITS,
  PACINGS,
  SETTINGS,
  TIMES_OF_DAY,
  VIDEO_FORMATS,
} from "@/lib/video-style";

/**
 * Request validation for the video-side picks.
 *
 * Kept apart from `video-style.ts` for the same reason `look-schema.ts` is kept
 * apart from `look.ts`: the option lists are imported by a client component and
 * should not drag zod into the browser bundle.
 */
export const videoStyleSchema = z.object({
  format: z.enum(VIDEO_FORMATS).optional(),
  pacing: z.enum(PACINGS).optional(),
  energy: z.enum(ENERGIES).optional(),
  setting: z.enum(SETTINGS).optional(),
  timeOfDay: z.enum(TIMES_OF_DAY).optional(),
  outfit: z.enum(OUTFITS).optional(),
  hook: z.enum(HOOKS).optional(),
  ending: z.enum(ENDINGS).optional(),
});
