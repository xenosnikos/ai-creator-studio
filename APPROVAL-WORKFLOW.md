# Granular approval workflow

The project now stops at two explicit cost gates.

1. Creating a project writes the storyboard and script only. `autoRender` is ignored by the
   public create route and the storyboard job no longer chains media jobs.
2. The operator edits each scene's dialogue and direction, then approves the current plan.
3. Only preview stills can be generated at this point. Every creator reference is loaded from
   its durable local copy and re-uploaded for a live provider before the render is submitted.
4. Each scene's current still is approved individually. The database stores the approved
   image asset id, so replacing a still makes the old approval unusable.
5. Voice/video requests are rejected unless the plan is approved and every requested scene's
   newest still is the exact approved asset.

Changing words or shot direction revokes plan approval and the changed scene's still
approval. Generating a replacement still revokes that scene's still approval. A video is
considered current only when its `keyframeAssetId` matches the scene's newest still.

Run the checks with:

```powershell
npm run typecheck
npm run test:identity
npm run test:workflow
```

For the browser walkthrough, start the app with all providers set to `mock`, then run:

```powershell
$env:BASE_URL='http://127.0.0.1:3000'
npm run test:ui-approval
```

The browser test chooses exactly one 15-second scene, corrects its dialogue, proves the still
button is locked before plan approval, proves video is locked before still approval, and then
finishes a mock-only clip.
