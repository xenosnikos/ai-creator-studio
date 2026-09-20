import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finish the standalone bundle so `npm start` actually starts the app.
 *
 * `output: "standalone"` writes a self-contained server to `.next/standalone`,
 * but deliberately leaves out two directories that server needs at runtime:
 * `public` and `.next/static`. Next's own docs say to copy them yourself, and
 * until something did, the only ways to run a production build were the
 * Dockerfile (which copies them) or three commands typed by hand.
 *
 * `next start` is not the missing option. It refuses outright under this
 * config — "next start does not work with output: standalone" — and exits
 * without serving. That is what `npm start` used to run, and what the deploy
 * guide used to tell people to run, so a host that builds with Nixpacks and
 * starts with `npm start` would build cleanly and then never come up.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next", "standalone");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

await mkdir(path.join(standalone, ".next"), { recursive: true });

const copied = [];
// This app has no `public/` — its only static file is `src/app/icon.svg`, which
// Next compiles into the route tree. Copied when present rather than assumed,
// because assuming it fails the whole build on a project that does not have
// one, which is exactly what the Dockerfile's unconditional `COPY /app/public`
// would have done the first time anyone tried to build the image.
if (await exists(path.join(root, "public"))) {
  await cp(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
    force: true,
  });
  copied.push("public/");
}
if (await exists(path.join(root, ".next", "static"))) {
  await cp(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
    recursive: true,
    force: true,
  });
  copied.push(".next/static");
}

console.info(`[build] standalone bundle completed with ${copied.join(" and ") || "nothing to add"}`);
