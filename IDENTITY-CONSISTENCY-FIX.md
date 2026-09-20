# Identity consistency fix

## Scene-to-scene hair and wardrobe lock

- Scene 1 is now the appearance master for the project. Later preview stills
  wait for it and receive it as an explicitly named styling reference.
- The original creator reference remains the sole authority for face, skin and
  body; the scene-1 reference controls only the realised haircut, hair styling
  and complete outfit. This prevents facial drift from being chained forward.
- The full stored hair description is protected from prompt-budget compression.
- Non-empty storyboard wardrobe descriptions must give an exact colour,
  material and cut for every visible garment and repeat the same description
  across all scenes.
- Rendering remains approval-gated: the appearance lock affects preview stills
  only and cannot bypass storyboard or still approval.

This build fixes the cross-scene creator drift visible in the supplied
30-second render.

## Root cause

The reference selector said creator anchors were first, but actually placed a
generated angle-matching identity-sheet image before the creator's seed photos.
If one generated sheet angle drifted, every scene requesting that angle could
become that different person. Later keyframes also received the previous
rendered keyframe as a location reference, including its person, so an error
could propagate.

## Changes

- Seed/user-uploaded creator photos are the first and authoritative references.
- Unreviewed generated sheet images do not condition scene keyframes. A sheet
  image is used only if the operator explicitly marks it as an anchor.
- The reference selector and KIE adapter now share the real eight-image cap.
- Creator references are re-uploaded from their durable local files before live
  identity-sheet and keyframe requests. Missing local references fail before a
  paid render instead of silently producing a stranger.
- Uploaded wardrobe, location and style images are re-hosted before submission;
  browser-only data URLs are no longer passed to the remote model.
- Rendered people are no longer chained from one keyframe into the next.
  Location continuity uses one person-free source photo or cached empty plate.
- Every keyframe receives explicit identity-reference slot numbers and a rule
  that people in location, wardrobe or style references are not the subject.
- One outfit is resolved and locked for the entire project.
- Scene asset metadata records which reference slots carried identity and which
  wardrobe was locked.

## Deploy and rerender

1. Back up the existing `data` directory or Railway volume.
2. Deploy this source while preserving that same data volume.
3. Open the creator and confirm at least one seed/reference photo is visible.
   Re-upload it if the local file is genuinely missing.
4. Rerender **keyframes first**, then rerender clips/everything. Existing videos
   and existing keyframes cannot change retroactively.

Run `npm run test:identity`, `npm run typecheck`, and `npm run build` to verify
the identity regression check and production build.
