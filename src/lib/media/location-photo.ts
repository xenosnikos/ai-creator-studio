import { config } from "@/lib/config";

/**
 * Find a real photograph of a place on the web, to condition a scene on.
 *
 * A generated location is the weakest part of a generated video. The model
 * invents a street that reads as *a* street rather than *this* street, and the
 * subject ends up standing in front of it rather than in it. Handing the render
 * an actual photograph of an actual place fixes both at once — proven side by
 * side on the same model and the same creator, where the only difference was a
 * photo of a Tokyo alley attached as a reference.
 *
 * The operator can upload one. Most of the time they will not, and the app
 * should not need them to: the storyboard already says where the scene happens,
 * which is a search query.
 *
 * Three sources, tried in order. Unsplash and Pexels are what a photographer
 * would pick from and want a free API key; Openverse needs no key at all, so
 * the feature works on a fresh install with nothing configured and improves
 * when a key is added.
 */

export interface LocationPhoto {
  /** Direct URL of the image file. */
  url: string;
  /** Photographer and source, for attribution. */
  credit: string;
  source: "unsplash" | "pexels" | "openverse";
  width: number;
  height: number;
}

/**
 * Portrait or square only, and this filter earns its keep twice.
 *
 * Scenes are shot vertical, and a 3:2 landscape photograph of a room is a poor
 * reference for a 9:16 frame — the model has to invent the top and bottom of
 * the space, which is the part it invents badly.
 *
 * It also stands in for something that cannot be searched for directly. A
 * photograph taken from above cannot be matched by a shot of someone standing
 * in the place at eye level; overhead and establishing shots are overwhelmingly
 * landscape, so preferring portrait quietly prefers the view from inside.
 */
const MAX_ASPECT = 4 / 3;

/** Below this the photo has no detail to lend the render. */
const MIN_WIDTH = 900;

export async function findLocationPhoto(query: string): Promise<LocationPhoto | null> {
  const cleaned = query.trim();
  if (!cleaned) return null;

  for (const search of [searchUnsplash, searchPexels, searchOpenverse]) {
    try {
      const photo = await search(cleaned);
      if (photo) return photo;
    } catch {
      // A photo source being down is not a reason to fail a render — the scene
      // still has its written description. Fall through to the next source.
    }
  }
  return null;
}

function usable(width: number, height: number): boolean {
  return width >= MIN_WIDTH && width / height <= MAX_ASPECT;
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

/**
 * Unsplash. Best pictures of the three, and the orientation filter is done
 * server-side so the candidates come back already the right shape.
 */
async function searchUnsplash(query: string): Promise<LocationPhoto | null> {
  const key = config.photos.unsplashAccessKey;
  if (!key) return null;

  const data = (await json(
    `https://api.unsplash.com/search/photos?per_page=10&orientation=portrait&query=${encodeURIComponent(query)}`,
    { Authorization: `Client-ID ${key}` },
  )) as {
    results?: Array<{
      width: number;
      height: number;
      urls?: { full?: string; regular?: string };
      user?: { name?: string };
    }>;
  };

  for (const hit of data.results ?? []) {
    const url = hit.urls?.full ?? hit.urls?.regular;
    if (url && usable(hit.width, hit.height)) {
      return {
        url,
        credit: `${hit.user?.name ?? "Unknown"} / Unsplash`,
        source: "unsplash",
        width: hit.width,
        height: hit.height,
      };
    }
  }
  return null;
}

async function searchPexels(query: string): Promise<LocationPhoto | null> {
  const key = config.photos.pexelsApiKey;
  if (!key) return null;

  const data = (await json(
    `https://api.pexels.com/v1/search?per_page=10&orientation=portrait&query=${encodeURIComponent(query)}`,
    { Authorization: key },
  )) as {
    photos?: Array<{
      width: number;
      height: number;
      photographer?: string;
      src?: { large2x?: string; original?: string };
    }>;
  };

  for (const hit of data.photos ?? []) {
    const url = hit.src?.large2x ?? hit.src?.original;
    if (url && usable(hit.width, hit.height)) {
      return {
        url,
        credit: `${hit.photographer ?? "Unknown"} / Pexels`,
        source: "pexels",
        width: hit.width,
        height: hit.height,
      };
    }
  }
  return null;
}

/**
 * Openverse. No key, no signup, so this is what a fresh install uses.
 *
 * It has no orientation filter, so the shape test does the work here and more
 * candidates are requested to compensate. Restricted to licences that permit
 * commercial use and modification — the photo conditions a render that is
 * likely to be published.
 */
async function searchOpenverse(query: string): Promise<LocationPhoto | null> {
  const data = (await json(
    "https://api.openverse.org/v1/images/?page_size=20&license_type=commercial,modification" +
      `&q=${encodeURIComponent(query)}`,
  )) as {
    results?: Array<{
      url?: string;
      width?: number;
      height?: number;
      creator?: string;
      source?: string;
    }>;
  };

  for (const hit of data.results ?? []) {
    const width = hit.width ?? 0;
    const height = hit.height ?? 0;
    if (hit.url && usable(width, height)) {
      return {
        url: hit.url,
        credit: `${hit.creator ?? "Unknown"} / ${hit.source ?? "Openverse"}`,
        source: "openverse",
        width,
        height,
      };
    }
  }
  return null;
}

/**
 * Turn a scene's location into something worth searching for.
 *
 * Short. Openverse requires every term to match, so a descriptive query returns
 * nothing at all — "home kitchen morning interior view at eye level" found zero
 * images where "home kitchen morning" found two hundred and forty. The instinct
 * to describe the shot in the query is the wrong one; the query names the place
 * and its light, and the shape filter does the rest.
 *
 * Light is worth the two extra words. "tokyo alley at night" and "tokyo alley"
 * return different pictures, and the render has to match a time of day.
 */
export function locationSearchQuery(locationKey: string, environment: string): string {
  const place = locationKey.replace(/_/g, " ").trim();
  const light = TIME_WORDS.find((word) => environment.toLowerCase().includes(word)) ?? "";
  return [place, light].filter(Boolean).join(" ");
}

const TIME_WORDS = [
  "night",
  "evening",
  "dusk",
  "sunset",
  "morning",
  "sunrise",
  "afternoon",
  "daylight",
];
