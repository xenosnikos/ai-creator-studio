# Reference resizing (selective v24 port)

All four reference upload paths (creator intake, creator refresh, project context,
and stored-asset rehosting) prepare upload bytes without rewriting durable originals.
Raster images exceeding a 2048px long side or 8 MiB input size are auto-oriented,
scaled inside 2048 × 2048 without enlargement, flattened onto white, and encoded
as JPEG at quality 92. Converted MIME is `image/jpeg`; the filename becomes `.jpg`
when the MIME changes. Small images retain their exact bytes and declared MIME.

## Deliberately preserved limitations

This is best-effort sizing, **not image validation**. SVG-declared inputs bypass
processing. Invalid/unreadable images and any sharp processing failure return the
original bytes and declared MIME for the provider to judge. Small images with an
incorrect declared MIME are not corrected. The byte threshold triggers conversion;
it is not a guaranteed hard cap on output size. The existing context filename
fallback still gives SVG uploads a `.jpg` name while retaining `image/svg+xml`.
The legacy creator bypass checks the literal provider name `mock`; the current
mock adapter is named `mock:image`, so it takes the ordinary local-file upload path.
None of these behaviors is expanded or repaired in this selective port.

## Verification

Run `npm run test:references` for deterministic generated fixtures, an offline
upload spy, a temporary database/assets directory, and a fetch guard. Coverage
includes size and byte thresholds, unchanged small formats, EXIF orientation,
white alpha flattening, SVG placeholders, invalid input/MIME behavior, all four
upload paths, caching, and preservation of durable originals. No live provider is
selected or called.

Typecheck without lifecycle hooks:

```
node node_modules/typescript/bin/tsc --noEmit
```

`sharp` is pinned directly to `0.35.4` in the manifest and lockfile. GitHub's
[GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
affects versions below `0.35.0` (first patched: `0.35.0`), and
[GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
affects versions below `0.35.4` (first patched: `0.35.4`). The direct dependency
therefore uses a patched release for both advisories. The npm override
`"sharp": "$sharp"` applies that direct pin to transitive dependencies as well,
including Next.js image optimization, so the lockfile contains no older sharp
copy. This also changes the sharp version used by Next.js outside its declared
range; compatibility must be checked with a clean `npm ci`, the build and tests,
and a Next.js image-optimizer smoke test before release. Install from the updated
lockfile before running verification; an existing installation of `0.34.5`
remains affected until replaced.
