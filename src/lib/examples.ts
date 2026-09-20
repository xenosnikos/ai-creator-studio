import type { VideoDuration } from "@/lib/types";

/**
 * Example briefs. These double as the "example prompts" deliverable and as
 * one-click starting points in the new-project form.
 */
export const EXAMPLE_PROMPTS: Array<{
  prompt: string;
  category: string;
  duration: VideoDuration;
  globalStyle: string;
}> = [
  {
    prompt:
      "Creator walking through downtown Tokyo at night explaining the three best ramen shops locals actually queue for.",
    category: "Travel / food",
    duration: 30,
    globalStyle: "cinematic neon night, anamorphic flare, shallow depth of field, 35mm",
  },
  {
    prompt:
      "Creator sitting in a luxury corner office discussing why most people are investing in AI the wrong way.",
    category: "Finance",
    duration: 30,
    globalStyle: "warm tungsten interior, soft contrast, editorial, 50mm",
  },
  {
    prompt:
      "Creator on a quiet beach at sunrise sharing a five-minute morning routine that fixed their focus.",
    category: "Wellness",
    duration: 15,
    globalStyle: "golden hour, natural light, soft pastel grade, handheld",
  },
  {
    prompt:
      "Creator in a bright modern kitchen demonstrating a one-pan weeknight dinner in under ten minutes.",
    category: "Food",
    duration: 60,
    globalStyle: "clean daylight, high key, crisp product photography feel",
  },
  {
    prompt:
      "Creator in a minimalist apartment breaking down three habits that quietly ruin your sleep.",
    category: "Lifestyle",
    duration: 30,
    globalStyle: "muted neutral palette, soft window light, calm documentary",
  },
  {
    prompt:
      "Creator in a coffee shop explaining how they landed their first freelance client with no portfolio.",
    category: "Career",
    duration: 60,
    globalStyle: "warm ambient interior, bokeh background, conversational handheld",
  },
];

/** Shorthand instructions that demonstrate the instruction-control surface. */
export const EXAMPLE_INSTRUCTIONS = [
  "Medium shot, smiling, holding coffee, sunrise lighting, cinematic.",
  "Close-up, thoughtful, head tilted, hard side light, moody.",
  "Wide shot from behind, walking away down the street, dusk, tracking.",
  "Three-quarter, laughing, gesturing with both hands, soft window light.",
];
