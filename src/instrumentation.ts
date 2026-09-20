/**
 * Next.js calls this once when the server process boots. We use it to start the
 * job runner (which also re-queues anything left `running` by a crash or
 * restart) and to seed an empty database, so a fresh `docker run` or a new
 * hosted deployment comes up with sample creators rather than a blank screen.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.AUTO_SEED !== "false") {
    try {
      const { seedIfEmpty } = await import("@/lib/seed");
      const result = seedIfEmpty();
      if (result.seeded) {
        console.info(`[seed] created ${result.creators.length} sample creator(s)`);
      }
    } catch (error) {
      // Never let seeding stop the server from starting.
      console.warn("[seed] skipped:", error instanceof Error ? error.message : error);
    }
  }

  const { startRunner } = await import("@/lib/jobs/runner");
  startRunner();
}
