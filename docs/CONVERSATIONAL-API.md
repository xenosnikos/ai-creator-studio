# Driving the studio from outside

Everything the web UI does, it does over this HTTP API. There is no private
surface and no session state: a script, an agent, or an MCP server can create a
creator, write a storyboard, approve it, render it and download the result using
only the endpoints below.

Written for that caller rather than for the browser. The shapes here were read
off the route handlers (`src/app/api/**/route.ts`) and the zod schemas they parse
with — they are what the server actually accepts, not a summary of intent.

Base URL is wherever the app is running; `http://localhost:3000` throughout.
There is **no authentication**. This is a single-operator tool, and exposing it
publicly exposes the ability to spend money on renders — see `docs/DEPLOY.md`
before putting it on a hostname.

## Conventions

- JSON in, JSON out. `Content-Type: application/json` on every POST/PATCH.
- Errors are `{ "error": "<message>", "detail": <optional> }`. The message is
  written to be shown to a person; a `409` in particular names the step you
  skipped, so it is usually the instruction for what to do next.
  `422` means the body failed validation and `detail` carries the zod flatten.
- **`202` means queued, not done.** Every generation endpoint returns job rows
  and returns immediately. Nothing is rendered synchronously.
- Ids are prefixed by type: `crt_` creator, `prj_` project, `scn_` scene,
  `job_` job, `ast_` asset. They are opaque strings.
- Asset URLs come back as app-relative paths (`/api/assets/projects/<id>/…`).
  Prefix the base URL to fetch one. The provider's own `remoteUrl` is also
  returned and may already have expired — prefer `url`.

## The gates, and why they exist

The pipeline is deliberately not one call. Each stage costs real money at a
provider, and each gate is the point where a cheap mistake stops being a cheap
mistake:

```
create project ──▶ storyboard ──▶ APPROVE STORYBOARD ──▶ stills
                      ▲                                    │
                      └──── revise and re-run ─────┐        ▼
                                                   │  APPROVE EACH STILL
                                                   │        │
                                                   └────────┴─▶ voice / video ──▶ cut ──▶ export
```

- Preview stills cannot be queued until `POST /approve-storyboard`.
- Voice and video cannot be queued until **every targeted scene's newest still**
  has been approved individually.
- `image` and `voice`/`video` cannot be requested in the same call — they are
  separate approval steps and asking for both is a `409`.
- Any content edit (`PATCH` of a project's prompt, transcript, settings, refs or
  creator) clears the storyboard approval, so it has to be given again.

An external caller that ignores this gets a `409` with the reason; it never
silently renders.

## 1. Check the providers are live

```bash
curl -s localhost:3000/api/health
```

```json
{ "providers": {
  "image": { "provider": "kie",        "ready": true },
  "video": { "provider": "kie",        "ready": true },
  "voice": { "provider": "elevenlabs", "ready": true },
  "llm":   { "provider": "anthropic",  "ready": true }
} }
```

`ready: false` means that stage's API key is missing. `provider: "mock"` is
always ready and produces offline placeholders — useful for exercising a client
without spending anything.

## 2. Create a creator

A project needs a creator, and a creator needs an identity sheet before anything
can be rendered with them. Photos are optional: with none, the appearance is
invented from `appearanceNotes` and a seed frame is rendered automatically.

```bash
curl -s -X POST localhost:3000/api/creators \
  -H 'content-type: application/json' \
  -d '{
    "name": "Maya Chen",
    "category": "food",
    "persona": "Home cook who explains one technique per video, dry and fast.",
    "referenceImages": ["https://example.com/maya-1.jpg"],
    "appearanceNotes": "Early 30s, shoulder-length dark hair, warm medium skin tone",
    "buildIdentitySheet": true
  }'
```

`referenceImages` accepts plain `https://` URLs **or** `data:` URLs, up to 10.
Returns `201 { "creator": { …, "identity": {…}, "voice": {…}, "references": [] } }`.
The identity block is written synchronously by Claude; the reference renders are
queued (`creator_bootstrap`, `identity_sheet`) and take a few minutes.

Related: `POST /api/creators/{id}/references` to add more ground-truth photos,
`POST /api/creators/{id}/identity-sheet` to rebuild the sheet
(`{ "angles": ["close_up"], "replace": false }`), `GET /api/creators` to list.

Wait for the creator to reach `status: "ready"` (`GET /api/creators/{id}`) before
rendering a project with them.

## 3. Create a project

One call carries the brief, the script, the settings and every reference image.

```bash
curl -s -X POST localhost:3000/api/projects \
  -H 'content-type: application/json' \
  -d '{
    "title": "Knife skills in 30 seconds",
    "prompt": "Maya explains why a sharp knife is safer than a blunt one, filmed in her kitchen.",
    "creatorId": "crt_…",
    "transcript": "A sharp knife is safer than a blunt one. Here is why…",
    "settings": {
      "kind": "video",
      "aspectRatio": "9:16",
      "targetDurationSeconds": 30,
      "imageQuality": "high",
      "audioMode": "lipsync",
      "look": "social",
      "music": { "mood": "off" },
      "roomTone": "light"
    },
    "backgroundRefs": ["https://example.com/her-kitchen.jpg"],
    "wardrobeRefs":   ["https://example.com/the-apron.jpg"],
    "styleRefs":      [],
    "autoStoryboard": true
  }'
```

Field notes, all verified against `src/app/api/projects/route.ts`:

| Field | Type | Meaning |
| --- | --- | --- |
| `prompt` | string, 5–4000 | The brief. Required. |
| `transcript` | string, ≤20000 | **Optional script.** Supplied, it is used verbatim — the writer only decides where the splits fall. Omitted, a script is written from the brief. |
| `backgroundRefs` / `styleRefs` / `wardrobeRefs` | string[], ≤6 each | Plain `https://` URLs or `data:` URLs. A remote URL is stored as given and downloaded and re-hosted on the image provider at render time, so it only has to be reachable from the server. |
| `settings.kind` | `video` \| `photo` | A photo set is silent stills; `photoCount` (1–12) replaces the duration. |
| `settings.requestedSceneCount` | int, optional | Exact number of cuts. Omitted means the writer chooses. |
| `settings.targetDurationSeconds` | int, 5–90 | Scene durations are normalised to sum to this. |
| `autoStoryboard` | bool, default `true` | **Queues the storyboard job only.** Never media. |
| `autoRender` | — | Accepted and forced to `false`. Writing a storyboard must not start billable renders. |

Returns `201 { "project": { "id": "prj_…", "status": "draft", … } }`.
With `autoStoryboard: false`, run the storyboard later with
`POST /api/projects/{id}/storyboard`.

### What the storyboard job guarantees

For `kind: "video"` the parser rejects a storyboard whose scenes are mostly
silent: every scene needs a line of at least 12 characters, except at most 25%
of them (rounded down, minimum 1) which may be wordless B-roll. A rejected
generation is retried once with the schema restated. Photo sets are unaffected —
their stills are silent by definition.

## 4. Poll the jobs

```bash
curl -s "localhost:3000/api/jobs?projectId=prj_…"
```

```json
{ "jobs": [{
  "id": "job_…",
  "type": "storyboard",
  "status": "running",
  "progress": 85,
  "projectId": "prj_…",
  "sceneId": null,
  "creatorId": "crt_…",
  "result": null,
  "error": null,
  "createdAt": "2026-09-20T10:11:12.000Z",
  "updatedAt": "2026-09-20T10:11:40.000Z"
}] }
```

Newest first. `status` is one of `queued | running | succeeded | failed |
cancelled`; the last three are terminal. `type` is `storyboard`,
`identity_sheet`, `creator_bootstrap`, `scene_image`, `scene_voice`,
`scene_video` or `project_cut`. Poll every couple of seconds; an image takes
tens of seconds, a clip a few minutes.

`?creatorId=` scopes to a creator instead. `POST /api/jobs/{id}/cancel` cancels
one; `POST /api/jobs/all/cancel` with `{"projectId":"prj_…"}` cancels everything
pending for a project. Cancelling a *running* job stops you waiting on it — the
provider still bills for work already in flight.

## 5. Read the storyboard

```bash
curl -s localhost:3000/api/projects/prj_…
```

Returns the whole project view — this is the one read endpoint a client needs:

```json
{
  "project": { "id": "prj_…", "title": "…", "transcript": "…",
               "settings": {…}, "storyboardApprovedAt": null, "status": "storyboarded" },
  "creator": { "id": "crt_…", "name": "Maya Chen", "references": [...] },
  "scenes": [{
    "id": "scn_…",
    "index": 0,
    "title": "Cold open",
    "dialogue": "A sharp knife is safer than a blunt one.",
    "durationSeconds": 6,
    "spec": { "locationKey": "galley_kitchen", "shotType": "medium_close_up",
              "cameraMove": "static", "subjectAngle": "front",
              "action": "{CREATOR} lifts the knife to the light", "facialExpression": "…",
              "pose": "…", "wardrobe": "", "environment": "…", "lighting": "…",
              "mood": "…", "styleNotes": "…", "motion": "…" },
    "readableAction": "Maya Chen lifts the knife to the light",
    "image": null, "video": null, "audio": null,
    "stillApproved": false,
    "status": {
      "image": { "state": "empty",   "progress": 0, "error": null, "blockedReason": null },
      "voice": { "state": "blocked", "progress": 0, "error": null,
                 "blockedReason": "Approve the current preview still first." },
      "video": { "state": "blocked", "progress": 0, "error": null,
                 "blockedReason": "Needs its preview still first." }
    }
  }],
  "finalCut": null,
  "swapCreators": [],
  "jobs": [...],
  "totals": { "images": 0, "videos": 0, "audio": 0 }
}
```

`status[stage].state` is `empty | queued | running | done | failed | cancelled |
blocked` and is resolved server-side from the latest job rather than from asset
presence — a re-render that failed reports `failed` even though the previous
image is still attached. A client can drive the entire pipeline off these seven
values plus `stillApproved`.

The subject in `spec.action` and `spec.motion` is always the literal token
`{CREATOR}`; `readableAction` / `readableMotion` are the same text with the
creator's name substituted, for display.

## 6. Revise before approving

Three levers, in increasing order of bluntness:

```bash
# a) Edit one shot or one line. Everything is optional.
curl -s -X PATCH localhost:3000/api/scenes/scn_… \
  -H 'content-type: application/json' \
  -d '{ "dialogue": "A blunt knife is the one that slips.",
        "durationSeconds": 6,
        "spec": { "shotType": "close_up", "cameraMove": "slow_push_in",
                  "subjectAngle": "front", "action": "{CREATOR} turns the blade over",
                  "facialExpression": "dry, amused", "pose": "leaning on the counter",
                  "wardrobe": "", "environment": "galley kitchen, morning",
                  "lighting": "hard window light from camera left", "mood": "dry",
                  "styleNotes": "front camera, no grade", "motion": "{CREATOR} steadies the blade" } }'

# b) Change the brief, the script, the settings or the references.
curl -s -X PATCH localhost:3000/api/projects/prj_… \
  -H 'content-type: application/json' \
  -d '{ "prompt": "…rewritten brief…", "backgroundRefs": ["https://…/kitchen-2.jpg"] }'

# c) Throw the storyboard away and write a new one from the current brief.
curl -s -X POST localhost:3000/api/projects/prj_…/storyboard
```

`spec` on a scene PATCH is all-or-nothing: send the complete object (only
`locationKey` may be omitted, and it then keeps the scene where it was).

(b) and (c) both discard the storyboard approval — (c) also replaces every scene
row, so scene ids change. A scene edited with (a) invalidates only its own
still: the approval is keyed to a fingerprint of the scene, so re-approving
requires a fresh render.

## 7. Approve the storyboard

```bash
curl -s -X POST localhost:3000/api/projects/prj_…/approve-storyboard
```

No body. Returns the full project view with `project.storyboardApprovedAt` set.
`409 "Generate the storyboard first."` if there are no scenes yet.

## 8. Render, one stage at a time

```bash
# Stills for every scene (or pass sceneIds to re-render a few).
curl -s -X POST localhost:3000/api/projects/prj_…/render \
  -H 'content-type: application/json' \
  -d '{ "stages": ["image"] }'
```

```json
{ "jobs": [ { "id": "job_…", "type": "scene_image", "status": "queued", … } ], "skipped": 0 }
```

`skipped` counts scenes that already had that stage queued or running — a
repeated call is safe and will not bill twice.

Then, per scene, once its `scene_image` job has succeeded:

```bash
curl -s -X POST localhost:3000/api/scenes/scn_…/approve-still
```

This approves *exactly* the newest image asset for that scene. If the scene has
been edited since the render, it returns `409` and a new still is required.

With every targeted scene approved:

```bash
# Narration only — useful to audition a script before paying for video.
curl -s -X POST localhost:3000/api/projects/prj_…/render \
  -H 'content-type: application/json' -d '{ "stages": ["voice"] }'

# Clips. Renders (or reuses) the voice, sizes the clip to the narration,
# joins picture and sound, and queues the cut behind the last shot.
curl -s -X POST localhost:3000/api/projects/prj_…/render \
  -H 'content-type: application/json' -d '{ "stages": ["video"] }'

# Re-join the existing clips into the final video. Must be requested alone.
curl -s -X POST localhost:3000/api/projects/prj_…/render \
  -H 'content-type: application/json' -d '{ "stages": ["cut"] }'
```

Body fields: `stages` (`image` | `voice` | `video` | `cut`, at least one),
`sceneIds` (optional, limits the render), `creatorId` (optional — render these
same scenes as a different creator).

`cut` runs automatically as each clip lands, so requesting it by hand is only
needed to recover an assembly that failed on its own (a music bed that 402'd, a
machine that had no ffmpeg at the time). It costs nothing: it is ffmpeg over
clips already paid for.

When the cut exists, `GET /api/projects/{id}` returns it:

```json
"finalCut": { "url": "/api/assets/projects/prj_…/final-…-scored.mp4",
              "bytes": 8123456, "audio": "light room sound · calm music, ducked under the voice" }
```

## 9. Export

```bash
curl -s -o bundle.zip localhost:3000/api/projects/prj_…/export
```

A ZIP of every asset plus the text deliverables (script, shot list, prompts).
Binary response, not JSON — `Content-Disposition` carries the filename.

## 10. Swap the creator (optional)

```bash
curl -s -X POST localhost:3000/api/projects/prj_…/swap \
  -H 'content-type: application/json' \
  -d '{ "creatorId": "crt_other", "mode": "compare", "stages": ["image"] }'
```

`compare` renders a parallel set of stills for the other creator and leaves the
project alone; `replace` re-points the project at them. The storyboard is never
regenerated — the subject is a token, so a swap is a substitution. Comparison is
a stills-only step: video for a swapped creator goes through `replace` and the
normal approval gates.

## Minimal end-to-end script

```bash
BASE=http://localhost:3000
CREATOR=crt_…

PRJ=$(curl -s -X POST $BASE/api/projects -H 'content-type: application/json' -d "{
  \"title\":\"Knife skills\",
  \"prompt\":\"Maya explains why a sharp knife is safer than a blunt one.\",
  \"creatorId\":\"$CREATOR\",
  \"backgroundRefs\":[\"https://example.com/her-kitchen.jpg\"],
  \"autoStoryboard\":true }" | jq -r .project.id)

# 1. wait for the storyboard
until [ "$(curl -s "$BASE/api/jobs?projectId=$PRJ" | jq -r '.jobs[0].status')" = "succeeded" ]; do sleep 3; done

# 2. read it, revise if needed, then approve
curl -s $BASE/api/projects/$PRJ | jq '.scenes[] | {index, title, dialogue}'
curl -s -X POST $BASE/api/projects/$PRJ/approve-storyboard > /dev/null

# 3. stills, then approve each one
curl -s -X POST $BASE/api/projects/$PRJ/render -H 'content-type: application/json' -d '{"stages":["image"]}'
# …poll until every scene's status.image.state == "done"…
for SCN in $(curl -s $BASE/api/projects/$PRJ | jq -r '.scenes[].id'); do
  curl -s -X POST $BASE/api/scenes/$SCN/approve-still > /dev/null
done

# 4. clips (voice is rendered inside this stage), then collect the cut
curl -s -X POST $BASE/api/projects/$PRJ/render -H 'content-type: application/json' -d '{"stages":["video"]}'
# …poll until every scene's status.video.state == "done"…
curl -s $BASE/api/projects/$PRJ | jq -r '.finalCut.url'
curl -s -o bundle.zip $BASE/api/projects/$PRJ/export
```

## Two behaviours worth knowing about as a caller

**Narration is enforced for video projects.** See §3 — a storyboard where more
than a quarter of the scenes are silent is rejected at the parse boundary, not
rendered with holes in it.

**Wide shots with a crowd are tightened automatically.** When a scene's shot
type is `wide` or `extreme_wide` and its `action` mentions other people, the
image stage renders a second, tightened variant (front-on subject, tight
framing) and keeps that one, because a small face among other faces is where
identity is lost. It is recorded on the asset rather than done silently:
`scenes[].image.meta.gate === "identity-tightened"`, alongside
`gateRequestedAngle` and `gateSupersededUrl` — the angle the storyboard asked
for and the first render it replaced.
