import { notFound } from "next/navigation";

import { CreatorWorkspace } from "@/components/CreatorWorkspace";
import { buildCreatorView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function CreatorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = buildCreatorView(id);
  if (!view) notFound();
  return <CreatorWorkspace initial={view} />;
}
