import Link from "next/link";

import { NewProjectForm } from "@/components/NewProjectForm";
import { EXAMPLE_PROMPTS } from "@/lib/examples";
import { creators } from "@/lib/repo";

export const dynamic = "force-dynamic";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ creator?: string; prompt?: string }>;
}) {
  const { creator, prompt } = await searchParams;
  const all = creators.list();

  if (all.length === 0) {
    return (
      <div className="panel mx-auto max-w-xl p-8 text-center">
        <p className="text-sm text-muted">
          You need a creator first — a project renders <em>somebody</em>.
        </p>
        <Link href="/creators/new" className="btn btn-primary mt-4">
          Create a creator
        </Link>
      </div>
    );
  }

  return (
    <NewProjectForm
      creators={all.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        referenceCount: c.references.length,
      }))}
      defaultCreatorId={creator ?? all[0].id}
      // Arrives from the example briefs on the home page, so clicking one lands
      // in the form with the brief already written rather than on an empty box.
      defaultPrompt={prompt ?? ""}
      examples={EXAMPLE_PROMPTS}
    />
  );
}
