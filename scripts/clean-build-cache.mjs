/**
 * Remove build caches that can outlive the process that wrote them.
 *
 *   node scripts/clean-build-cache.mjs          # stale dev types only
 *   node scripts/clean-build-cache.mjs --all    # the whole .next directory
 *   node scripts/clean-build-cache.mjs --data   # database and generated assets
 *
 * Plain .mjs, run by `node` directly: this executes before every build, on
 * machines where `rm -rf` does not exist and where a quoting mistake in a
 * package.json one-liner would be the first thing a reviewer sees.
 *
 * Why the default target exists at all: `next dev` writes typed-route
 * definitions into `.next/dev/types`, and adds that path to tsconfig's
 * `include` itself — so a production `next build` type-checks them. Interrupt
 * the dev server mid-write (Ctrl-C, closing the terminal, a crash) and the file
 * is left truncated, which fails every later build with a syntax error inside a
 * generated file the operator never wrote:
 *
 *     .next/dev/types/routes.d.ts:99:30  Type error: ';' expected.
 *
 * Nothing regenerates it except `next dev`, so the build stays broken until the
 * directory is removed. Editing tsconfig would not help — Next rewrites the
 * include on the next dev start.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const targets = process.argv.includes("--data")
  ? ["data"]
  : process.argv.includes("--all")
    ? [".next"]
    : [path.join(".next", "dev")];

for (const target of targets) {
  fs.rmSync(path.join(root, target), { recursive: true, force: true });
}
