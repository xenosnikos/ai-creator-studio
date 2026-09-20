/**
 * Seed the studio with sample creators and an example project.
 *
 *   npm run seed
 *
 * The app also seeds itself on first boot when the database is empty, so this
 * script is only needed when you want to seed explicitly (e.g. after a reset).
 */

import { seedIfEmpty } from "../src/lib/seed";

const result = seedIfEmpty();

if (!result.seeded) {
  console.log("Studio already has content. Run `npm run reset` to start clean.");
} else {
  for (const name of result.creators) console.log(`  creator  ${name}`);
  console.log(`  project  Tokyo ramen guide`);
  console.log(
    [
      "",
      "Seeded. Next:",
      "  1. npm run dev",
      "  2. Open a creator and click 'Rebuild identity sheet' to generate their",
      "     six canonical angles (this is the identity-consistency proof).",
      "  3. Open the example project and click 'Generate storyboard'.",
      "",
      "Add your API keys on the Settings page to switch from placeholder assets",
      "to real generated output.",
      "",
    ].join("\n"),
  );
}
