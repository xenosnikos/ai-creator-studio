# Replacing models and providers

Every vendor sits behind one of four interfaces in `src/lib/providers/types.ts`. Nothing
above that directory names a vendor, so swapping one is a contained change.

There are two levels of swap:

1. **Same vendor, different model** — change an environment variable. No code.
2. **Different vendor** — write one adapter and register it. No application code.

---

## 1. Same vendor, different model

All KIE-hosted model ids are environment variables:

```dotenv
KIE_IMAGE_MODEL=nano-banana-pro
KIE_VIDEO_MODEL_SPEECH=bytedance/seedance-2-fast
KIE_VOICE_MODEL_TTS=elevenlabs/text-to-speech-multilingual-v2
KIE_LIPSYNC_MODEL=volcengine/video-to-video-lip-sync
ANTHROPIC_MODEL=claude-sonnet-5
```

Voice is the exception: it does **not** go through KIE by default. See
[Voice goes direct](#voice-goes-direct-to-elevenlabs) below.

### Two image models, routed by purpose

Not every image in the pipeline wants the same model, so `ImageRequest.purpose`
decides which one runs:

| Purpose | Used by | Model |
| --- | --- | --- |
| `creator` | bootstrap portrait, identity sheet | `KIE_IMAGE_MODEL_CREATOR` |
| `scene` (default) | scene renders, location plates | `KIE_IMAGE_MODEL_T2I` / `_I2I` |

The two families do not share an input schema, which is the whole reason the
adapter branches: one takes a `resolution` tier and `image_input`, the other a
`quality` name and `image_urls`. Sending the wrong shape returns
`500: This field is required` and does not say which field.

A split like this only works if a face survives the hand-off, so that was tested
directly: a creator portrait rendered by the creator model, uploaded, then used
as the reference for a scene rendered by the scene model. The features, hair and
wardrobe came through intact.

### Verified against a live account

Every id and parameter below was exercised against a real KIE key, not taken from docs.

| Model | Required input | Notes |
| --- | --- | --- |
| `nano-banana-pro` | `prompt` | `resolution`: `1K`, `2K` or `4K`. Prompt up to 10000 chars. Pass `image_input` (up to 8) to get image-to-image — there is no separate model id for it. |
| `elevenlabs/text-to-speech-multilingual-v2` | `text`, `voice` | The field is `voice`; the validator's error text calls it `voiceId`, which is misleading. |
| `elevenlabs/text-to-dialogue-v3` | `dialogue: [{text, voice}]` | Expressive, multi-speaker. Different schema from multilingual-v2 — the adapter branches on the model id. |
| `volcengine/video-to-video-lip-sync` | `mode`, `video_url`, `audio_url` | `mode`: `lite` or `basic`. `basic` adds scene detection + speaker id. |

Two things worth knowing because they are not in the docs:

- **File upload is on a different host.** `POST https://kieai.redpandaai.co/api/file-base64-upload`.
  `api.kie.ai` returns 404 for it. That is what `KIE_UPLOAD_BASE_URL` defaults to.
- **`code: 422` means the model id does not exist; `code: 500` means the id is real and the
  input is wrong.** Submitting a deliberately empty input is a free way to tell whether an id
  is on your plan — a rejected request costs no credits.

### The ElevenLabs models: three documentation errors

Verified against a live account, and worth writing down because KIE's published docs are
wrong on all three points:

1. **`dialogue` is an array, not a string.** The docs declare it `Type: string` and show a
   stringified JSON array in the example. Sending that form is rejected by the service's
   own parser: `syntax error, expect {, actual string`. Send a real array.
2. **`language_code: "auto"` is rejected**, despite being the documented default and a
   listed option — `422 Invalid language_code parameter: auto`. Send a real code (`en`) or
   omit the field.
3. **`voice` takes an ElevenLabs voice id**, not the friendly name the playground picker
   shows. The docs' own example uses `"voice": "TX3LPaxmHKxFdv7VOQHJ"`.

The adapter sends the corrected shape. Fixing all three still leaves generation failing
with `failCode: 500` / `internal error, please try again later` — including for **KIE's own
documented example content**, which is the test that settles where the fault lies. Per
KIE's error table, 500 is "Internal server error".

So a persistent voice failure has two possible causes, and they are distinguishable:

| Symptom | Meaning |
| --- | --- |
| `422` naming a parameter | Your request. Fix it — the message says which field. |
| `failCode: 500`, `internal error, please try again later`, **0 credits** | Theirs. Retry later; if it persists, quote the failing task id to KIE support. |

KIE also genuinely fails a fraction of *other* tasks with "The server is busy", consuming no
credits. The client retries these (see below); lip sync in testing needed three attempts
before succeeding. The voice 500, by contrast, never cleared — which is why voice moved off
KIE entirely.

Changing the image model, for example, is one line:

```dotenv
KIE_IMAGE_MODEL=some-other-model
```

**Caveat:** the image adapter sends `nano-banana-pro`'s input schema — a `resolution` tier
and `image_input`. A model wanting different field names or enum values (Seedream, for one,
takes a `quality` name and `image_urls`) needs a small edit in
`src/lib/providers/kie/image.ts`, or its own adapter.

---

## What a render actually does, in order

```
creator (once — skipped if it already exists)
  └─ identity block + multi-angle identity sheet
       │
       ├─ location plate      one empty render per distinct locationKey, reused
       │                      by every scene set there
       │
       └─ per scene:
            keyframe   = identity anchors + [previous shot in this location]
                         + location plate + background/style refs
            voice      = ElevenLabs, creator's locked voice
            clip       = keyframe + voice → Seedance (speech-synced motion)
```

**Scene count follows the story, not a table.** A brief that is one moment in one
place renders as a single unbroken clip — 10 seconds, one scene, one keyframe. A
scene is added only when the story changes location, subject or beat, or when a
line would overrun the model's clip ceiling. The only hard limit is a ceiling
derived from the target duration, so a short piece cannot be shredded into more
cuts than its seconds can carry.

**Two scenes in the same place chain; two scenes in different places do not.**
The plate fixes the room in the abstract; once scene 1 resolves it into a real
frame, scene 2 in that same location takes scene 1's keyframe as an additional
reference so it agrees with how the room actually came out. The chain is scoped
to a shared `locationKey` and only ever looks backwards.

This is not the frame-to-frame chaining the identity system avoids. The previous
shot is one reference *behind the creator's anchors*, never a replacement for
them — so a frame that drifted cannot pull the person along with it, and a
location change breaks the chain rather than dragging the old room into the new
one.

---

## Talking scenes: Seedance, not Kling + lip sync

`VIDEO_PROVIDER=kie` selects **Seedance 2.0 fast**, which takes the scene's voice track as
a reference and generates motion that is already speaking it. The lip-sync stage is then
skipped entirely — the clip arrives in sync, with sound, and the asset records
`audioMode: "native"`.

This replaced Kling + lip sync after measuring both on the same keyframe and the same voice:

| | Kling i2v → `volcengine` lip sync | Seedance 2.0 fast |
| --- | --- | --- |
| Mouth over 2.4s of continuous speech | Fixed smile. No jaw movement at all. | Phoneme-level articulation |
| Transcript of the result | n/a (no speech animated) | Word-for-word match to the script |
| Passes needed | 2 (+ retries; lip sync often returns "server is busy") | 1 |

Lip sync as a repair pass has to detect a face, crop it, regenerate the mouth and composite
it back onto a performance the video model already committed to. On a subject who is moving
toward the lens, motion-blurred, or holding a wide grin, it degrades to a no-op. A model
that is told the words up front never has that problem.

Kling has been removed from the codebase entirely. It was kept for a while as a silent
B-roll path, but a second video model that cannot speak earns its keep only if something
uses it, and nothing did — every scene in this app is either a talking shot or a silent one
Seedance renders just as well.

Two Seedance behaviours worth knowing:

- **The reference audio is a reference, not a soundtrack.** It re-performs the line rather
  than muxing your file. The words and the timbre carry over — verified by transcribing the
  output (identical) and comparing pitch (median F0 within 5% of the source) — but the
  timing is its own. If a scene needs the exact ElevenLabs waveform, set the project's audio
  mode to `mux`.
- **720p is the ceiling.** There is no 1080p tier; the adapter clamps.

### Writing a talking scene

Two things caused the "lips don't move" failure, and only one of them was the model.

The storyboard was writing dialogue scenes as *action* beats — `"strides briskly toward the
camera"`, `"excited, wide grin"`, `"moves quickly toward the lens"` — for a scene carrying
ten seconds of speech. The clip did exactly what it was told. `STORYBOARD_SYSTEM` now
constrains any scene with dialogue to a stationary medium/close shot with a mouth-free
expression; B-roll scenes are explicitly exempt, since that is where movement belongs.

`compileVideoPrompt` also switches to a speaking form when a voice track is present. Two
details in it are load-bearing:

- **No negations.** "She does not walk toward the camera" gets acted out. Every constraint
  is phrased as what she *does*: "stays planted in one spot with her weight settled".
- **The ending is named.** "She finishes the last sentence, closes her mouth and holds
  still." Without this the model invents motion to fill whatever clip time is left after
  the speech ends — which is exactly where end-of-clip drift came from.

For the same reason, `tailPaddingSeconds` is **not** applied when the provider generates its
own speech: padding a clip past the end of the line is what creates the empty tail.

---

## Voice goes direct to ElevenLabs

`VOICE_PROVIDER=elevenlabs` calls `api.elevenlabs.io` with your own ElevenLabs key. It is
the default for live voice because the KIE route, as documented above, returns a 500 for
every request no matter what is sent. Images, clips and lip sync are unaffected — they still
run through whatever `IMAGE_PROVIDER` / `VIDEO_PROVIDER` / `LIPSYNC_PROVIDER` name.

```dotenv
VOICE_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
```

### Premade voices only, on a free plan

This is the trap worth knowing about, because it fails **at render time** rather than when
you pick the voice:

```
402 paid_plan_required — Free users cannot use library voices via the API
```

Voice Library entries — the ones you browse and "add to your voices" on the website — are a
paid feature via the API. **Premade** voices (Jessica, Sarah, Liam, George…) work on every
plan. A live free-tier account carried 32 of them.

The creator form calls `GET /v1/voices` and lists only `premade` and `cloned` entries, so
picking from the form cannot produce a 402. `PREMADE_VOICES` in
`src/lib/providers/elevenlabs/voice.ts` is the fallback list when that call fails.

### Making it not sound like AI

Two settings do most of the work, and the old defaults had both wrong:

- **`ELEVENLABS_MODEL=eleven_v3`.** Markedly more natural than `multilingual_v2`.
- **`stability: 0.0`.** On v3 this is three-valued — 0.0 Creative, 0.5 Natural, 1.0 Robust —
  and everything above Creative is a brake on delivery. The original default of 0.75 sat in
  the flat, over-controlled register that people mean when they say a voice "sounds like AI";
  0.5 was better and still even, and largely ignored the audio tags below. Creative is the
  mode that performs them. Consistency across videos comes from locking the voice *id*, not
  from suppressing delivery, which is what makes spending this budget safe.
  `similarityBoost` moves to 0.9 with it — Creative is free to vary, and similarity is what
  keeps that variation inside the chosen voice — and `style` drops to 0.35, because it
  exaggerates on top of expressiveness that is already unlocked.

v3 also reads inline delivery tags — `[warmly] Tokyo after midnight…` — which are
interpreted rather than spoken. (Confirmed by transcribing a tagged render: the tag does not
appear in the words.) `deliveryTagFor()` picks one from the scene's mood, so a project does
not come back in one flat register from end to end.

On a line over ~60 characters the adapter also drops a single `[pause]` at the first clause
boundary, which is where a person breathes anyway — v3 reads straight through a comma, so a
long sentence otherwise arrives as one unbroken push. One tag per line, never inside a word,
and nothing at all on a line that already carries a tag of its own: a hand-scored line has
had this decision made for it.

The adapter handles v3's quirks: `stability` is snapped to the nearest legal step, and
`speed` is omitted because v3 rejects it.

**Creating a custom voice is not possible on a free plan.** Both `/v1/text-to-voice/design`
and `/v1/text-to-voice/create-previews` return `feature_not_available` — "Creating a voice
through the API is only available on a paid plan". Voice cloning is likewise paid. On a free
plan the premade list is the whole menu.

### Synchronous, unlike everything else

ElevenLabs returns audio bytes from the POST rather than a task id to poll. The adapter
keeps the `submit`/`poll` shape anyway — `submit` does the work and stashes the result, and
the first `poll` hands it back — so the job runner, progress reporting and retry logic need
no special case. That is the only reason this provider looks slightly odd next to the
others.

### The voice is locked per creator

`VoiceConfig` stores a provider-native `voiceId` for the creator's lifetime, and that id is
what delivers *the same voice in every video*. The expressiveness knobs around it
(`stability` 0.0, `similarityBoost` 0.9, `style` 0.35) are tuned for a believable read
rather than a suppressed one — see above for why the id, not the settings, is what holds
identity.

It also rules out the video model's own audio. Kling and Veo will happily generate speech
over a clip, and it sounds fine — but it is a **different voice every generation**, which
breaks the one property a virtual creator has to have. Their audio is discarded; the
ElevenLabs track is what gets lip-synced on.

---

## Sound on video

Three env vars and one per-project setting control how a voice track reaches a clip.

```dotenv
LIPSYNC_PROVIDER=kie          # or `mock`
KIE_LIPSYNC_MODEL=sync/lipsync-v2
VIDEO_TAIL_PADDING_SECONDS=0.6   # breathing room after the last word
FFMPEG_PATH=/usr/bin/ffmpeg      # optional; found on PATH by default
```

The project's `audioMode` picks the target, and the pipeline degrades from there:

| Mode | What happens | Falls back to |
| --- | --- | --- |
| `lipsync` | Clip's mouth driven from the voice track | `mux`, then `separate` |
| `mux` | Voice laid over the clip with ffmpeg | `separate` |
| `separate` | Clip and voice delivered as two files | — |

Every downgrade is written to the asset (`meta.audioMode`, `meta.audioNote`) and shown on
the scene card. A render is never failed over sound.

**ffmpeg is optional and never installed by this project.** It is probed on `PATH` once per
process. Without it, `mux` degrades to `separate`; `lipsync` is unaffected, because that
runs provider-side.

Clip length is derived from the *measured* duration of the scene's narration
(`src/lib/media/duration.ts` parses WAV and MP3 headers directly), not from the storyboard's
estimate. If a line is longer than the video model's maximum clip, the clip is clamped and
the overrun is reported on the scene rather than silently trimming the sentence.

---

## 2. Different vendor

### The interfaces

```ts
interface ImageProvider {
  name: string;
  submit(request: ImageRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
  uploadImage(bytes: Buffer, fileName: string, mimeType: string): Promise<string>;
}

interface VideoProvider {
  name: string;
  minClipSeconds: number;      // the planner clamps scene durations to this range
  maxClipSeconds: number;
  submit(request: VideoRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
}

interface VoiceProvider {
  name: string;
  submit(request: VoiceRequest): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
  listVoices(): Promise<Array<{ id: string; label: string }>>;
}

interface LLMProvider {
  name: string;
  json<T>(request: LLMJsonRequest<T>): Promise<T>;   // schema-constrained only
}
```

Media providers are modelled as **async task APIs** (submit → poll) because that is the
lowest common denominator. A synchronous provider just returns a terminal status on the first
poll:

```ts
async submit(request: ImageRequest): Promise<TaskHandle> {
  const url = await this.renderSynchronously(request);
  const taskId = crypto.randomUUID();
  this.done.set(taskId, url);
  return { taskId, provider: this.name };
}

async poll(handle: TaskHandle): Promise<TaskResult> {
  const url = this.done.get(handle.taskId)!;
  return { status: "succeeded", progress: 100, urls: [url] };
}
```

### Worked example — swapping the image provider for Replicate

**1. Write the adapter** — `src/lib/providers/replicate/image.ts`:

```ts
import type { ImageProvider, ImageRequest, TaskHandle, TaskResult } from "@/lib/providers/types";

export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate:flux";

  async submit(request: ImageRequest): Promise<TaskHandle> {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: process.env.REPLICATE_IMAGE_VERSION,
        input: {
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio,
          // Identity anchors. If your model takes only one, pass referenceUrls[0] —
          // the compiler already orders them best-first.
          image_prompt: request.referenceUrls[0],
        },
      }),
    });
    const body = await response.json();
    return { taskId: body.id, provider: this.name };
  }

  async poll(handle: TaskHandle): Promise<TaskResult> {
    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${handle.taskId}`,
      { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` } },
    );
    const body = await response.json();
    if (body.status === "failed" || body.status === "canceled") {
      return { status: "failed", progress: 0, urls: [], error: body.error ?? "failed" };
    }
    if (body.status !== "succeeded") {
      return { status: "pending", progress: 50, urls: [] };
    }
    const urls = Array.isArray(body.output) ? body.output : [body.output];
    return { status: "succeeded", progress: 100, urls, raw: body };
  }

  async uploadImage(bytes: Buffer, _fileName: string, mimeType: string): Promise<string> {
    // Replicate accepts data URLs directly, so no upload host is needed.
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  }
}
```

**2. Register it** — `src/lib/providers/registry.ts`:

```ts
const imageProviders: Record<string, () => ImageProvider> = {
  kie: () => new KieImageProvider(),
  mock: () => new MockImageProvider(),
  replicate: () => new ReplicateImageProvider(),   // ← add
};
```

**3. Select it** — `.env.local`:

```dotenv
IMAGE_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_IMAGE_VERSION=...
```

That is the entire change. No page, route, job handler or prompt code is touched.

---

## What an image provider must support

The identity-consistency approach depends on one capability. If a candidate model lacks it,
consistency will degrade no matter how good the model is otherwise.

| Capability | Why it matters | Fallback if missing |
| --- | --- | --- |
| **Image-to-image with reference images** | The primary identity mechanism. | None that preserves identity. Do not swap to a text-only model. |
| Multiple reference images (ideally ≥ 4) | Lets angle-matched anchors and seed references be combined. | Pass `referenceUrls[0]`; the compiler orders them best-first, so you still get the most relevant anchor. |
| Reference images by URL | The app uploads references and passes URLs. | Implement `uploadImage` to return a data URL instead. |
| Aspect-ratio control | Vertical social formats. | Crop post-render. |

For video, the requirement is **image-to-video**. A text-to-video model cannot preserve
identity, because nothing constrains the face.

---

## Swapping the LLM

`LLMProvider.json()` is the only method, and it requires **schema-constrained structured
output**. The three call sites (`src/lib/ai/`) each pass a JSON Schema plus a zod validator;
a model that cannot be constrained to a schema will fail validation and the adapter's one
retry will not save it.

If your target model supports tool-calling but not native structured output, implement
`json()` as a single forced tool call whose parameters are the schema.

`LLMJsonRequest.task` (`"identity_block" | "storyboard" | "scene_prompt"`) is ignored by real
adapters — it exists so the mock can route to a canned generator.

Note that `identity_block` is a **vision** call: `request.images` carries the creator's
reference photos. A text-only LLM can still run the app, but creators must then be described
by hand rather than read from photos.

---

## Swapping the lip-sync provider

`LipSyncProvider` is the smallest interface in the codebase — submit a video URL plus an
audio URL, poll for a result URL:

```ts
export interface LipSyncProvider {
  readonly name: string;
  submit(request: { videoUrl: string; audioUrl: string }): Promise<TaskHandle>;
  poll(handle: TaskHandle): Promise<TaskResult>;
}
```

Write an adapter, add a line to `lipSyncProviders` in `src/lib/providers/registry.ts`, and
select it with `LIPSYNC_PROVIDER` or the Settings page. Both inputs must be URLs the vendor
can fetch; the pipeline already refuses to call the provider with local or `data:` URLs and
falls through to muxing instead.

---

## Adding a whole new capability

Music, sound effects, lip-sync and similar follow the same pattern:

1. Add an interface to `src/lib/providers/types.ts`.
2. Add an adapter directory and a `mock/` implementation.
3. Add a registry map + accessor in `registry.ts` and a `*_PROVIDER` env var in `config.ts`.
4. Add a `JobType` in `types.ts` and a handler in `src/lib/jobs/handlers.ts`.
5. Surface it in the UI.

The mock implementation is not optional busywork — it is what keeps the app runnable and
demoable without keys, and it is how the pipeline gets tested without spending credits.
