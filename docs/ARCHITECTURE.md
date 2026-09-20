# Architecture

## The one idea

```
render = identity_kit(creator)  ×  scene_spec(scene)
```

A **creator** owns who the person is. A **scene** owns what happens. They are stored
separately, they never contaminate each other, and they are combined in exactly one
place — the prompt compiler. Every capability in the POC falls out of that separation:

- Holding the left operand fixed while varying the right = **identity consistency**.
- Holding the right operand fixed while varying the left = **character swapping**.
- Making the combination a pure function = **repeatable results**.

---

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ app/            Next.js pages + REST API                             │
│ components/     React UI                                             │
├──────────────────────────────────────────────────────────────────────┤
│ lib/views.ts    View models (assets resolved per scene + per creator) │
├──────────────────────────────────────────────────────────────────────┤
│ lib/jobs/       Job runner + handlers — every slow operation          │
│ lib/ai/         Structured Claude calls (schema-constrained)          │
│ lib/prompting.ts  THE PROMPT COMPILER — pure, deterministic           │
│ lib/export/     ZIP bundle                                            │
├──────────────────────────────────────────────────────────────────────┤
│ lib/media/      Audio duration parsing · optional ffmpeg mux          │
├──────────────────────────────────────────────────────────────────────┤
│ lib/providers/  Image │ Video │ Voice │ LipSync │ LLM                 │
│              kie/ (Nano Banana, Seedance, ElevenLabs)  anthropic/  mock/ │
├──────────────────────────────────────────────────────────────────────┤
│ lib/repo.ts     Repositories       lib/db.ts   SQLite schema          │
│ lib/storage.ts  Local asset mirror                                    │
└──────────────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. No layer above `providers/` names a vendor; no layer below
`jobs/` knows what a job is.

---

## Data model

```
Creator ─┬─ IdentityBlock   (locked canonical description + drift guards)
         ├─ VoiceConfig     (voice id + stability/similarity/style/speed)
         ├─ promptSeed      (folded into prompts for run-to-run stability)
         └─ CreatorReference[]
              ├─ kind: "seed"   uploaded ground truth, anchored
              └─ kind: "sheet"  generated canonical angle (front/¾/profile/rear/CU/full)

Project ─┬─ ProjectSettings  (aspect ratio, quality, duration, resolution, global style,
         │                    audioMode: lipsync | mux | separate)
         ├─ transcript
         ├─ backgroundRefs[] styleRefs[]
         └─ Scene[]
              ├─ SceneSpec    ← creator-agnostic; subject is the token {CREATOR}
              ├─ dialogue
              └─ durationSeconds

Asset ── (kind, projectId, sceneId, creatorId, remoteUrl, localPath, prompt, meta)
Job   ── (type, status, progress, projectId, sceneId, creatorId, input, result, error)
```

Two details carry weight:

- **`Asset.creatorId`** is what makes swap-compare possible. Rendering a scene as a different
  creator writes a parallel asset rather than overwriting, so both versions coexist and can
  be shown side by side.
- **`Asset.prompt`** stores the exact compiled prompt. Reproducibility is a deliverable, not
  a claim — `prompts.json` in the export bundle is generated from this column.

---

## The prompt compiler

`src/lib/prompting.ts`. Deliberately a pure function rather than an LLM call: the same inputs
must produce byte-identical output, or repeatability is unverifiable.

```
[identity block]      ← verbatim from the creator, always first
[angle directive]     ← fixed phrasing per canonical angle
[shot grammar]        ← fixed phrasing per shot type / camera move
[scene spec]          ← action, expression, pose, wardrobe, environment, lighting, mood
[global style]        ← project-level direction
[quality constants]
[negative guards]     ← base drift guards + the creator's own
[consistency key]     ← creator promptSeed
```

Ordering is load-bearing. The identity block leads because earlier tokens dominate, and the
negatives trail because they qualify everything above.

**Reference selection** (`selectReferences`) is ordered too, and reserves slots so context
references can never crowd out identity anchors:

1. Identity-sheet shots matching this scene's `subjectAngle`
2. Anchored seed references
3. Remaining seed references
4. Other sheet angles
5. Background / style references (capped at 3 of the 10 slots)

The video prompt is intentionally different: it describes *motion only* and never
re-describes the subject, because the keyframe already encodes identity and restating it
competes with the conditioning image.

---

## Pipelines

Every slow operation is a job, so the UI never blocks and any single step is retryable in
isolation.

| Job | Does | Depends on |
| --- | --- | --- |
| `creator_bootstrap` | Text-to-image seed portrait for a creator with no photos | — |
| `identity_sheet` | One render per canonical angle, from the seed anchors | seed references |
| `storyboard` | Scenes + shot list + dialogue + transcript via Claude | — |
| `scene_image` | Keyframe, image-to-image against angle-matched anchors | identity sheet |
| `scene_voice` | Per-scene narration in the creator's locked voice | storyboard |
| `scene_video` | Voice → clip sized to the narration → sound attached | `scene_image` |

The runner (`lib/jobs/runner.ts`) claims work transactionally, caps concurrency at 3,
tolerates transient poll failures, maps provider progress into a monotonic bar, and re-queues
jobs orphaned by a restart. Bulk renders are queued **stage-major** — every keyframe before
any clip — so video jobs always find their source image ready.

### Why `scene_video` does three things

Splitting voice, clip and mux into separate jobs looks tidier and is wrong here, because the
three are not independent:

1. **The clip length is a function of the audio.** ElevenLabs will not hit a storyboard's
   5-second estimate exactly — a line budgeted at 5s comes back at 6.2s. Commissioning the
   clip before the narration exists means guessing, and a guess that is short cuts the
   sentence off. So the voice is generated (or waited for) first, the audio is *measured*
   from its own bytes (`lib/media/duration.ts` — WAV and MP3 parsed directly, no ffmpeg),
   and the clip is ordered at that length plus a short tail.
2. **Nothing else can guarantee the ordering.** With concurrency 3, stage-major queueing
   gets voice jobs *claimed* before video jobs but not *finished*. `scene_video` therefore
   waits on a sibling `scene_voice` job when one is in flight, and synthesises the line
   itself when none was queued. Both paths call the same `synthesizeSceneVoice`, so the two
   stages can never produce different takes of the same line.
3. **Attaching sound is a fallback chain, not a step.** `lipsync → mux → separate`, each
   degradation recorded on the asset (`meta.audioMode`, `meta.audioNote`) rather than
   thrown. A missing lip-sync model or a machine without ffmpeg costs you mouth sync — not
   the render you already paid for.

Lip sync is its own provider because it is its own class of model: an image-to-video model
animates a keyframe and cannot be told what is being said. It is the only stage that sees
picture and sound together.

### Failure is expected, so it is designed for

Live testing surfaced four distinct provider failures in a single session: a gateway 503, a
KIE "internal error" that persisted for the whole run, "the server is busy" on lip sync, and
Anthropic rejecting a JSON Schema keyword. None of them said anything about the request.
Three defences, in order of how early they catch:

1. **The HTTP client retries** transient statuses with backoff, and never retries a 4xx —
   that would be a request the provider will reject identically every time.
2. **The runner resubmits** a task the provider *accepted* and then failed for a
   provider-side reason (`TaskResult.retryable`), up to twice. These failures consume no
   credits.
3. **Stages degrade rather than fail.** A scene whose voice cannot be generated still
   produces its clip, cut to the storyboard's planned duration, with the reason recorded on
   the asset. Losing narration should not cost you the picture you already paid for.

Dependencies between stages are waited on, never assumed from queue order: `scene_video`
waits for its keyframe and its voice-over, and `identity_sheet` waits for the bootstrap
render that produces its seed. Queue order alone does not sequence anything when more than
one job runs at a time — every one of those three was a real bug found by running it.

ffmpeg is detected on `PATH` at runtime and never installed. A package that downloads an
encoder during `npm install` is exactly the install fragility this project removed once
already, and it would be taken on for a convenience step — without ffmpeg the clip and its
voice are still delivered, just as two files.

---

## Request flow: rendering one scene

```
POST /api/projects/:id/render  {stages:["image"], sceneIds:[…], creatorId?}
   │
   ├─ validate project, scenes, creator references and storyboard approval
   ├─ reject mixed image+video requests (the review gate cannot be skipped)
   ├─ for voice/video, require the newest image id to equal the approved image id
   ├─ jobs.create("scene_image") per scene           → returns 202 immediately
   └─ scheduleTick()
        │
        └─ runner claims the job
             ├─ compileImagePrompt(creator, scene.spec, globalStyle)
             ├─ selectReferences({references, angle, backgroundRefs, styleRefs})
             ├─ imageProvider().submit(...)          → provider taskId
             ├─ awaitTask(...) polls to terminal, reporting progress
             ├─ persistFromUrl(...)                  → local mirror
             └─ assets.create({..., prompt, creatorId})
```

`creatorId` on the job is the swap hook: omit it and the project's own creator is used; pass
one and the identical scene renders as somebody else.

The durable gates live in `projects.storyboard_approved_at` and
`scenes.approved_image_asset_id`. The latter is an asset id, not a boolean: a replacement
still can never inherit approval from the image it superseded. Editing any scene clears both
the project plan approval and that scene's still approval; regenerating only the still clears
the still approval while leaving the unchanged plan approved.

---

## Asset persistence

Provider result URLs expire. Every generated asset is downloaded into `DATA_DIR/assets` and
served through `/api/assets/[...path]`, which resolves and range-checks the path against the
assets root to block traversal. Two consequences worth stating: projects stay reviewable
indefinitely, and the export bundle is self-contained.

---

## What is intentionally simple

These are POC-scoped decisions, made knowingly:

- **SQLite + a synchronous driver.** One file, no daemon, no migration framework — but the
  schema is versioned so a real migration story can be added without a rewrite.
- **In-process job queue.** No Redis, no worker fleet. The `JobHandler` contract is the part
  worth keeping.
- **Polling, not websockets.** The UI polls `/api/jobs` every 2.5s.
- **A ~100-line ZIP writer** instead of an archiver dependency.
- **No auth.** Single-user local tool.
