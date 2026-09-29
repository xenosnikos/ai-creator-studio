# Public working baseline: selective v24 integration

This repository continues the customized AI Creator Studio v23 codebase. It is **not** a wholesale replacement with the v24 archive.

## Included from v24

- Reference-image resizing before upload to generation providers. Large reference images are reduced to a 2048-pixel longest edge and encoded as JPEG; small supported references retain their original bytes. Stored originals are not replaced.
- A dedicated regression test suite for reference normalization.
- `sharp` declared explicitly as a dependency instead of relying on Next.js's transitive installation.

## Preserved local functionality

- Storyboard-first conversational MCP server (`mcp-server.mjs`).
- Human storyboard and preview-still approval gates.
- Video dialogue-coverage validation.
- Existing voice-delivery defaults and identity-tightening behavior.
- The 64 MB development proxy upload allowance.

## Deliberately deferred

v24's voice cache/model changes, automatic voice selection, face verification, new video-reference handling and global voice-model defaults are **not** included in this baseline. Review found stale voice reuse during concurrent jobs and verification metadata that can outlive the image it checked. These need targeted fixes and regression tests before adoption. An LLM confidence score is not an identity guarantee.

Reference resizing happens **after** an upload reaches the server. It does not compress a phone's initial upload or make creator creation asynchronous; slow creator creation can still fail at the client/tunnel layer.

## Data and operating safety

- Keep `.env.local`, `data/`, API keys, creator reference photos and generated media local. The repository contains only source and bundled demonstration screenshots.
- **Never use `npm run reset` to clear build cache. It deletes the runtime database and generated assets.** Inspect scripts before running maintenance commands.
- Do not run cache-cleaning commands or `npm run typecheck`'s pre-hook against a live dev server. Use `npx tsc --noEmit` for a non-cleaning typecheck, and use an isolated copy for builds/tests.
- Back up SQLite using SQLite's backup API and preserve the asset directory before migrations or significant updates.
- Public source does not mean the running app is safe for anonymous access. It is a single-operator application; protect any tunnel/deployment with authentication before exposing API-backed generation.
- Never log or commit actual credentials. `.env.example` contains configuration placeholders only.

## Verification commands

Run from an isolated checkout with mock providers and no real credentials:

```sh
npm ci
npx tsc --noEmit
npm run test:identity
npm run test:workflow
npm run test:references
```

These checks do not prove live provider output quality. Paid generation, narration listening tests and human review of reference fidelity remain separate acceptance steps.
