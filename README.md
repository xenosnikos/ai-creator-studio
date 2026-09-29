# AI Creator Studio

**Working baseline:** customized v23 plus the reviewed v24 reference-image resizing improvement. See [what was integrated, deferred, and how to protect local data](docs/PUBLIC-BASELINE.md). This is not a wholesale v24 upgrade.

A proof of concept for an AI social-media content platform built around **consistent AI
creators**. Build a creator once, then reuse them across images, reels and short videos with
their face, body, voice and style intact — and swap one creator for another without
rewriting a single scene.

> **Status: proof of concept.** The goal is to demonstrate that the workflow is technically
> feasible and repeatable, not to ship a production service. Known limitations and the
> path to production are listed at the end of this file.

---

## What it does

| Requirement | Where it lives |
| --- | --- |
| Creator library — create, import, categorise, reuse | `/creators` |
| Identity consistency across front / side / rear / ¾ / close-up / full-body | Identity sheet on `/creators/[id]` |
| Character swapping with the scene preserved | Swap panel on `/projects/[id]` |
| Prompt-driven image, reel and short-video generation | `/projects/new` → `/projects/[id]` |
| Background / mood-board / style reference support | Reference pickers on `/projects/new` |
| Instruction control (camera, expression, pose, wardrobe, lighting, mood, motion) | "Edit shot" on each scene card |
| Storyboard generation (scenes, shot list, camera, action, dialogue, timing) | "Generate storyboard" |
| Script / transcript generation | Transcript panel + per-scene dialogue |
| Consistent voice per creator | Voice config locked onto the creator |
| Voice matched to the video | Clip cut to the measured narration; speech generated in-model from the voice track |
| Export | "Export bundle" → ZIP of assets, transcript, shot list and prompts |

---

## How identity consistency actually works

This is the part that matters, so it is worth being precise about it. Four mechanisms
compose:

**1. A locked identity block.** When you create a creator, Claude reads the reference
photos and writes a canonical physical description — face shape, eye shape and colour, nose,
lips, jaw, hairline, hair, skin tone and undertone, build, posture. That text is then
*frozen* and injected verbatim at the top of every prompt for that creator. Reference images
alone are not enough: a rear or full-body shot gives the model very little face to copy and
leans heavily on the text, and re-describing the creator per prompt reintroduces exactly the
run-to-run variance you are trying to remove.

**2. Image-to-image, always.** Every render goes through the image model's
image-to-image path with the creator's reference images attached. Pure text-to-image is used
exactly once — to invent the first frame of a synthetic creator who has no photos.

**3. An angle-matched identity sheet.** Each creator gets six canonical shots — front,
three-quarter, profile, rear, close-up, full-body — rendered from their seed references under
identical studio conditions. When a storyboard calls for a rear shot, the compiler attaches
the sheet's *rear* frame as the anchor rather than a frontal portrait. Feeding a front-facing
reference into a shot from behind is the single most common cause of the "wrong person from
behind" failure.

**4. Keyframe-seeded video.** The video model only ever works from a keyframe whose identity
the image model already locked. The video prompt deliberately does *not*
re-describe the subject — that would fight the conditioning image instead of reinforcing it.

The prompt compiler (`src/lib/prompting.ts`) is a **pure function**, not another LLM call, so
the same (creator, scene) pair compiles to a byte-identical prompt every time. That is what
makes "repeatable results" a checkable claim rather than an assertion.

### Why character swapping is a one-click operation

Storyboards are stored **creator-agnostic**. Claude is instructed to never describe the
presenter's appearance and to refer to them only as the literal token `{CREATOR}`. The
creator and the scene are combined in exactly one place — the prompt compiler. So swapping
is a substitution:

```
render = identity_kit(creator)  ×  scene_spec(scene)
```

Change the left operand, keep the right one. The environment, camera work, action, dialogue,
timing and lighting survive untouched. The workspace verifies this directly: after a swap,
the scene spec and dialogue are byte-identical between the two renders while the compiled
prompt differs only in the identity segment.

### Voice consistency

The voice id, stability, similarity and speed are locked onto the creator and reused for
every line in every project. Adjacent scene dialogue is passed to the TTS model as prosody
context, so scene-to-scene delivery flows instead of resetting to a fresh take each clip.

### Voice and picture actually joined up

A reel where the words and the mouth disagree is not usable output, so the video stage does
three things in one job, in this order:

1. **Voice first.** The narration is generated (or waited for) before the clip is
   commissioned.
2. **The clip is cut to the narration.** The audio's real duration is measured from its own
   bytes — WAV and MP3 headers are parsed directly, no ffmpeg needed — and the clip is
   ordered at that length plus a short tail. A line budgeted at 5s that comes back at 6.2s
   gets a 7s clip, instead of being cut off mid-word.
3. **Sound is already attached.** The video model takes the voice as a reference and
   returns a clip that is speaking it, so there is no separate joining step. Scenes without
   dialogue render silent, as they should.

What happened to a clip's audio is recorded on the asset and shown on the scene card, so a
scene that lost its narration says so rather than shipping quietly silent.

---

## Stack and model choices

| Concern | Choice | Why |
| --- | --- | --- |
| Images | **Nano Banana Pro** via KIE (`nano-banana-pro`) | Up to 8 reference images per request, which is what makes multi-anchor identity conditioning possible. Chosen over Seedream 5.0 Pro on a like-for-like test — identical prompt and reference, one render each — where Seedream produced the centred, glossy, posed-at-the-lens frame that reads as generated. One model covers creator portraits, scene keyframes and empty location plates. |
| Video | **Seedance 2.0 fast** via KIE (`bytedance/seedance-2-fast`) | Takes the voice track as a reference and generates speech-synchronised motion in one pass, so no lip-sync repair is needed. |
| Voice | **ElevenLabs v3**, called directly | Deterministic voice ids plus stability/similarity controls, and prosody context fields. Direct rather than via KIE because the KIE route returns a 500 for every request — see `docs/PROVIDERS.md`. |
| Reasoning | **Claude Sonnet 5** (Anthropic API) | Identity analysis from photos (vision), storyboarding, scripting, instruction parsing. All calls are schema-constrained. Set `ANTHROPIC_MODEL=claude-opus-5` for stronger storyboards at a higher per-call price. |
| App | Next.js 16 (App Router) + TypeScript + Tailwind | One process, one command to run. |
| Storage | SQLite via Node core (`node:sqlite`) + local filesystem | Zero infrastructure *and* zero native compilation — a hard native dependency here broke `npm install` on Windows. Assets are mirrored locally because provider URLs expire. |

Images, video and lip sync all share one KIE key, so the POC needs three credentials total —
KIE, Anthropic, ElevenLabs. Every one of them is swappable — see `docs/PROVIDERS.md`.

---

## Run it

`localhost` addresses below only work **after** you start the app on your own machine — they
are not public URLs.

### Option A — Docker (no Node install needed)

```bash
docker compose up
```

Then open **http://localhost:3000**.

### Option B — Node

Requires **Node 22.5+** ([nodejs.org](https://nodejs.org), LTS installer). The database uses
Node's built-in SQLite, so there is nothing to compile on any platform.

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**.

Either way there is **nothing to configure first**. The app creates its database, seeds three
sample creators and an example project on first boot, and starts in placeholder mode so the
whole workflow runs offline at zero cost.

### Adding your API keys

Open **Settings** in the top nav, paste your keys, and press **Test** on each — the button
calls the real service, so a bad paste is caught there instead of halfway through a render.
Saving a key automatically switches the matching stages from placeholder to live.

| Key | Powers | Get one at |
| --- | --- | --- |
| Anthropic | Storyboards, scripts, reading reference photos into an identity block | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| KIE AI | Images and video | [kie.ai/api-key](https://kie.ai/api-key) |
| ElevenLabs | Voice-over | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) |

Voice runs against ElevenLabs directly rather than through KIE, because the KIE-hosted
ElevenLabs models fail with a `500` on every request — including KIE's own documented example
payload. One caveat, since it only surfaces at render time: on a free ElevenLabs plan, **Voice
Library voices return `402`** and only *premade* voices work. The creator form lists just the
usable ones, so picking from it avoids the problem entirely.

Keys are stored in `$DATA_DIR/settings.json` with owner-only (0600) permissions, are never
sent back to the browser (the UI only ever sees a masked hint like `sk-ant-a••••••WXYZ`), and
can be cleared from the same page. The `ANTHROPIC_API_KEY` / `KIE_API_KEY` /
`ELEVENLABS_API_KEY` environment variables still work as a fallback, which is what you want
on a server.

The badge in the top-right always shows which providers are live, so it is never ambiguous
whether you are looking at real generations or placeholders.

> **No login.** This is a single-user local tool. If you host it anywhere reachable, put it
> behind your platform's password protection first — anyone with the URL could otherwise
> spend the credits attached to your keys.

### Sharing it with someone else

```bash
npm run share
```

One command: builds, generates a password, starts the server behind an HTTP Basic
gate, opens a public tunnel, and prints the link and password to hand over. Set
`SHARE_PASSWORD` to pick your own. Never share without it — there are no accounts,
so the URL alone is enough to drive the app and spend your credits.

### Want a real public URL?

See **`docs/DEPLOY.md`**. Short version: any host with a persistent volume (Railway, Render,
Fly.io, a VPS) works as-is; Vercel needs a storage/queue port first, and the doc explains why.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve (standalone server; `next start` does not work with `output: "standalone"`) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run seed` | Load the three sample creators and an example project |
| `npm run reset` | Delete the database and all generated assets, then re-seed |

---

## Walkthrough

1. **Create a creator** (`/creators/new`). Either upload 3–6 reference photos of the same
   person, or write a persona and let Claude invent the appearance. Pick a voice; the
   stability and similarity sliders are what keep delivery identical between videos.
2. **Build the identity sheet** (`/creators/[id]`). Six canonical angles from the same
   anchors. This is both the consistency evidence and the anchor pool later renders draw
   from. Regenerate any single angle if one comes out wrong.
3. **Start a project** (`/projects/new`). Choose what it produces — a **video** (storyboard,
   script, voice, clips) or a **photo set** (post-ready stills, no dialogue, sized for
   Instagram, LinkedIn or X in portrait, square or landscape). Then pick the creator, write a brief, set any duration
   from 5 to 90 seconds, choose the aspect ratio and global style, and optionally set the
   direction for this particular video — format, pacing, energy, setting, time of day,
   outfit, opening and ending. You can also attach photos of the outfit to wear, the actual
   place it happens in, and a style reference. For video, choose **Auto** scene count or an
   exact number of cuts. One continuous scene is available up to the model's 15-second clip
   limit.
4. **Create and approve the storyboard.** Claude produces a scene-by-scene shot list — shot type,
   camera move, subject angle, action, expression, pose, wardrobe, environment, lighting,
   mood, motion — plus per-scene dialogue and the full transcript, with durations summing
   exactly to your target. Creation stops here: no preview image, voice or video is generated.
   Correct each scene's words and direction, then approve the plan.
5. **Direct individual shots.** Open "Edit words & shot" on any scene. Type shorthand like
   *"Medium shot, smiling, holding coffee, sunrise lighting, cinematic."* and Claude expands
   it into the structured fields, which you can then edit directly.
6. **Review preview stills.** Generate stills only after plan approval. Approve the exact
   current still on every scene after checking face, skin tone, hair and outfit. Re-rendering
   a still automatically revokes its previous approval.
7. **Generate the video.** Voice and clips stay server-locked until the plan and every current
   still are approved. Each clip records the keyframe asset it animated, so an older clip is
   never presented as current after a still changes.
8. **Swap the creator.** Pick another creator and choose *Compare* (renders a parallel set
   side by side) or *Replace* (re-points the project). The storyboard is untouched.
9. **Export.** One ZIP with images, clips, audio, `transcript.txt`, `storyboard.md`,
   `shot-list.csv`, `prompts.json` (the exact compiled prompt behind every asset, plus how
   each clip's sound was handled) and `project.json` (the full identity kit, for
   reproduction).

Example briefs are on the home page and one click away in the new-project form.

---

## Architecture

See **`docs/ARCHITECTURE.md`** for the full picture, and **`docs/PROVIDERS.md`** for how to
replace any model or vendor. **`docs/CONVERSATIONAL-API.md`** is the same pipeline driven
over HTTP — exact request/response shapes for a script, an agent or an MCP server, with the
approval gates spelled out.

```
src/
  lib/
    types.ts            Domain model — Creator, IdentityBlock, SceneSpec, Project, Job
    prompting.ts        The prompt compiler (pure function; identity enforcement)
    providers/          Vendor adapters behind 4 interfaces
      types.ts            ImageProvider / VideoProvider / VoiceProvider / LLMProvider
      registry.ts         name -> implementation; the only file that names a vendor
      kie/                Nano Banana, Seedance, ElevenLabs
      anthropic/          Claude
      mock/               Offline stand-ins
    ai/                 Structured Claude calls (identity, storyboard, instructions)
    jobs/               DB-backed job runner + one handler per pipeline stage
    export/             ZIP bundle writer
    db.ts repo.ts       SQLite schema and repositories
  app/                  Next.js routes (pages + REST API)
  components/           React UI
```

---

## Limitations, and what production would need

Stated plainly, because a POC that hides its edges is not useful.

- **Clips are not stitched.** Scenes render as individual 3–15s clips; assembling them into
  one continuous file with the voice-over mixed under needs ffmpeg in the pipeline. The
  export bundle ships the parts.
- **The voice is re-performed, not muxed.** Seedance treats the ElevenLabs track as a
  reference: same words, same timbre, its own timing. Voice-identical output across videos
  needs the `mux` audio mode instead, which needs ffmpeg.
- **Custom voices need a paid ElevenLabs plan.** On a free plan the premade voices are the
  whole menu — voice design and cloning both return `feature_not_available`.
- **Identity drift is minimised, not eliminated.** Rear and extreme-wide shots are the
  weakest cases, since there is least face for the reference to constrain. The mitigations
  here — angle-matched anchors, a locked identity block, drift-guard negatives — measurably
  help but do not make it zero. A production system would add a face-similarity check on
  each render and auto-retry below a threshold, and would benefit from per-creator LoRA
  training where the model provider supports it.
- **The job queue is single-process.** SQLite-backed, in-memory concurrency, no cross-instance
  locking. Deliberate — it needs no infrastructure. The `JobHandler` contract is what a
  production system keeps when swapping in BullMQ or Temporal.
- **No authentication or multi-tenancy.** Single-user local tool. Anything hosted publicly
  is open to whoever has the URL, including the credits on your saved keys.
- **Provider-hosted reference URLs expire** (KIE keeps uploads ~3 days). Every asset is
  mirrored locally so nothing is lost, but very old creators may need their references
  re-uploaded before a new render.
- **Cost is not metered.** A 60s piece is roughly 8 keyframes + 8 clips + 8 voice lines;
  check current KIE pricing before batch runs. Longer pieces scale linearly — a 90s brief
  is at least six clips because no single clip can exceed 15 seconds.
