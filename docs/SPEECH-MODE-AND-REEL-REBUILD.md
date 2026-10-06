# Speech mode and the local reel rebuild

## Per-scene speech mode

`SceneSpec.speechMode` is optional: `"on_camera"` (the default when unset) or `"voiceover"`.

| | on_camera | voiceover |
|---|---|---|
| Dialogue | spoken to the lens | kept as narration over the shot |
| Video prompt | speaking performance with the words | the shot's own non-speaking motion; words are not sent |
| Voice file to video model | yes, lip-sync mode only | never |
| How audio is joined | the project's audio mode | always `mux` (exact take), or `separate` if the project asks for it |
| Project audio mode `mux` | **refused before any paid voice/video request** | allowed |

The refusal happens in `POST /api/projects/:id/render` (video stage only; voice and image stages are not blocked) and again inside the `scene_video` job handler, so a job queued another way can't get round it. The message offers two fixes: switch the project to lip-sync, or mark the scene as voice-over.

Fingerprints (`src/lib/scene-fingerprint.ts`):
- Still and voice hashes ignore `speechMode` entirely, so switching modes never invalidates an approved still or a paid voice take.
- The video hash includes `speechMode` only when it is `voiceover`. Unset and `on_camera` hash exactly as before the field existed, so existing clips stay valid.
- Editing a scene still revokes storyboard and still approval as before. Re-approving reuses the existing still, with no regeneration needed.

The shot editor has a "Line delivery" control. The storyboard writer and free-form instruction parser both emit or keep the mode. In a project set to `mux`, the writer is told to use voice-over.

Tests: `npm run test:speech-mode` (mock providers, stubbed network, temp DB).

## `scripts/rebuild-reel.mjs`

This rebuilds a reel from media that already exists. It calls no models and makes no network requests, and it never writes to its inputs.

```
node scripts/rebuild-reel.mjs \
  --manifest render-manifest.json \
  --raw-sources raw-sources.json \
  --stills preview-assets.json \
  --audio-assets audio-assets.json \
  --out /new/dir/that/does/not/exist \
  [--headings headings.json] \
  [--trim-eof-transient] [--dry-run]
```

- **Identity is matched by exact ID, never by position.** The manifest order is the reel order.
  - Every manifest scene needs a unique `sceneId` and `videoAssetId`.
  - `--raw-sources` needs exactly one entry per scene. Each entry's `videoAssetId` must equal the manifest's, and its `scene` number must equal the manifest position.
  - `--stills` needs exactly one entry per `sceneId`.
  - `--audio-assets` is **required** and needs exactly one entry per `sceneId`. Its `file` must be that scene's manifest narration file. A raw-sources `voiceAssetId`, if present, must agree with it.
  - Any missing, extra, duplicate, reordered or contradictory entry is refused (exit 3) before anything is written.
  - `voiceAssetId` is recorded only with that proof (`voiceAssetVerified: true` and `voiceAssetCheck` in the output manifest).
  - The lookup arrays may themselves be in any order.
- **Presenter scenes** use the retained raw motion (`rawMotionPath`, from `meta.silentClipPath`), found by exact `videoAssetId`.
  - Source frames 0..N-1 are used exactly at 24 fps. Nothing is padded, frozen, interpolated or stretched.
  - Non-24 fps sources are refused.
  - If the motion can't cover speech end plus 0.12 s, the run fails.
- **Photo cutaways** (approved still with `meta.provider: "licensed-source-photo"`) are re-rendered at 24 fps.
  - The zoom runs on an 8× oversampled image, so it isn't quantised to whole output pixels.
  - Aspect ratio is preserved. A mismatched still is centre-cropped; if the crop would keep less than 50% of the picture, the still is refused.
- **Audio** keeps the exact decoded narration samples at their native rate.
  - It only leaves out trailing audio after `speechEnd + margin`, where speech end is the last sample above −48 dBFS.
  - It adds 5 ms / 8 ms edge fades, applies one static master gain (−16 LUFS, true peak ≤ −1.5 dBTP with headroom), and encodes AAC once.
  - A short burst confined to the last 60 ms of a file is reported but only trimmed with `--trim-eof-transient`.
- **Captions** use approximate phrase timing: characters are spread over the measured voiced regions and snapped to measured pauses. This is **not** forced alignment.
- **Output:**
  - `reel.mp4`, `captions.ass`, `captions.srt`
  - `work/narration-master.wav`: the exact audio that was encoded
  - `rebuild-manifest.json`: input hashes, measured durations and frame counts, cut offsets, trims, fps, loudness, verification checks, and `lipSyncFixed:false` for every presenter scene
- **Publishing:** `reel.mp4` exists only for a verified run.
  - The encode writes to `work/reel.partial.mp4`.
  - Only after every hard check passes and `rebuild-manifest.json` is written does that file become `reel.mp4`.
  - If a hard check fails, `FAILED.json` is written (with the checks), and the unverified encode stays in `work/`.
  - On SIGINT, SIGTERM or SIGHUP, every running ffmpeg is killed, `FAILED.json` is written, and the process exits 128+signal.
  - Every ffmpeg call is asynchronous, so the handler runs promptly in any phase.
  - Soft-check failures (for example a long silence across a cut) still publish. The CLI prints them as `WARNING` lines and reports "hard checks passed; N soft check(s) FAILED", not "verification passed".
  - Limitation: a SIGKILL of the CLI can't be intercepted. An orphaned ffmpeg may then finish `work/reel.partial.mp4`, but never `reel.mp4`.
- **Refuses** to write into an existing `--out`.

**It cannot fix lip sync.** Presenter mouth movement in existing clips was generated without the recording.

Tests: `npm run test:rebuild-reel` (real bundled ffmpeg, synthetic fixtures).
