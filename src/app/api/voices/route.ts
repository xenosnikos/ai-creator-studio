import { ok, route } from "@/lib/api";
import { voiceProvider } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The voice catalogue for the creator form.
 *
 * Separate from `/api/health` because the two answer different questions and
 * want different costs. Health is a liveness check that should stay cheap;
 * this reaches a shared catalogue of ~15,000 voices and takes search terms, so
 * hanging it off the health check made every page that shows a provider badge
 * pay for a voice search it never used.
 */
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const value = (name: string) => params.get(name)?.trim() || undefined;

  return ok({
    voices: await voiceProvider().listVoices({
      search: value("search"),
      gender: value("gender"),
      age: value("age"),
      accent: value("accent"),
      useCase: value("useCase"),
    }),
  });
});
