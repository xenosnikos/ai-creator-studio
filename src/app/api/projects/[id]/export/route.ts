import { buildProjectBundle } from "@/lib/export/bundle";
import { fail, route } from "@/lib/api";
import { projects } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Download every asset plus the text deliverables as a single ZIP. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  if (!projects.get(id)) return fail("Project not found", 404);

  const bundle = await buildProjectBundle(id);
  return new Response(new Uint8Array(bundle.data), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.fileName}"`,
      "Content-Length": String(bundle.data.length),
    },
  });
});
