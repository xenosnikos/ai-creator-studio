import {
  DEFAULT_SPEECH_MODE,
  type AudioMode,
  type Scene,
  type SceneSpec,
  type SpeechMode,
} from "@/lib/types";

/**
 * Speech-mode rules shared by the render route, the video handler and the
 * project view. One module so the public gate and the handler recheck cannot
 * drift apart.
 */

/** The mode a scene actually renders with. Unset is the legacy behaviour. */
export function effectiveSpeechMode(spec: Pick<SceneSpec, "speechMode">): SpeechMode {
  return spec.speechMode === "voiceover" ? "voiceover" : DEFAULT_SPEECH_MODE;
}

/** True when the shot shows the presenter saying a line on camera. */
export function speaksOnCamera(scene: Pick<Scene, "spec" | "dialogue">): boolean {
  return Boolean(scene.dialogue.trim()) && effectiveSpeechMode(scene.spec) === "on_camera";
}

/** True when the scene's line is narration heard over a non-speaking shot. */
export function isVoiceover(scene: Pick<Scene, "spec" | "dialogue">): boolean {
  return Boolean(scene.dialogue.trim()) && effectiveSpeechMode(scene.spec) === "voiceover";
}

/**
 * How the voice is joined to this scene's clip.
 *
 * A voice-over always carries the exact recorded take, so it is overlaid
 * (`mux`) whatever the project default — lip sync would try to drive a mouth
 * that is deliberately not speaking, and the native path would re-perform the
 * line. `separate` is respected because it is an explicit request for the two
 * files unjoined, which still preserves the take.
 */
export function audioModeForScene(
  scene: Pick<Scene, "spec" | "dialogue">,
  projectAudioMode: AudioMode,
): AudioMode {
  if (isVoiceover(scene)) return projectAudioMode === "separate" ? "separate" : "mux";
  return projectAudioMode;
}

/**
 * Refuse a render that cannot produce a matching mouth, before it is paid for.
 *
 * `mux` attaches the recording to a clip whose mouth the video model invented
 * on its own; with an on-camera speaking shot the lips then visibly do not
 * match the words, and nothing downstream can repair that for free. Returns a
 * human explanation with the two ways out, or null when the scene may render.
 *
 * `separate` is deliberately not refused: it hands back the clip and the take
 * unjoined, which is the route for an operator who lip-syncs elsewhere.
 */
export function speechModeGate(
  scene: Pick<Scene, "spec" | "dialogue" | "index">,
  projectAudioMode: AudioMode,
): string | null {
  if (projectAudioMode !== "mux" || !speaksOnCamera(scene)) return null;
  return (
    `Scene ${scene.index + 1} is an on-camera speaking shot, but this project's audio mode is ` +
    `Overlay (mux). Overlay attaches the recorded narration to a clip whose mouth movement the ` +
    `video model invents on its own, so the lips will not match the words. No video was requested. ` +
    `Choose one: (1) switch the project's audio mode to lip-sync so the clip is performed from the ` +
    `voice, or (2) set this scene's speech mode to voice-over, so the presenter is shown not ` +
    `speaking and the exact recording plays as narration.`
  );
}
