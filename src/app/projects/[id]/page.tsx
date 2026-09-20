import { notFound } from "next/navigation";

import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { creators } from "@/lib/repo";
import { buildProjectView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = buildProjectView(id);
  if (!view) notFound();

  return (
    <ProjectWorkspace
      initial={view}
      creators={creators.list().map((creator) => ({
        id: creator.id,
        name: creator.name,
        referenceCount: creator.references.length,
      }))}
    />
  );
}
