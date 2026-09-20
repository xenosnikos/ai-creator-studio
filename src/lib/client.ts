"use client";

/** Tiny fetch wrapper: unwraps the API's error envelope into a thrown Error. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response from ${path}: ${text.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

/** Read a File into a data URL, which is what the reference endpoints accept. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Pull still frames out of a reference video, in the browser.
 *
 * The spec asks for optional reference *video* on a creator, and the identity
 * pipeline only ever consumes stills — so the useful thing a video gives us is
 * several frames of the same face under the same light from slightly different
 * angles, which is exactly what a good reference set looks like.
 *
 * Done client-side deliberately. The alternative is shipping the whole file to
 * the server and decoding it with ffmpeg, which means a binary dependency on
 * the critical path of creating a creator, and this app already treats ffmpeg
 * as optional. Every browser that can play the file can also seek it and draw
 * it to a canvas, so the upload stays a handful of JPEGs rather than a
 * multi-megabyte video.
 *
 * Frames are taken at even intervals across the middle of the clip: the first
 * and last moments of a hand-held video are usually the worst of it — the
 * camera being raised, the subject not looking yet.
 */
export function videoToFrames(file: File, count = 4): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const frames: string[] = [];
    let targets: number[] = [];
    let index = 0;

    const cleanup = () => URL.revokeObjectURL(url);
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    video.onerror = () =>
      fail("That video could not be read in this browser. Try an MP4, or upload photos.");

    video.onloadeddata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!duration) return fail("That video has no readable duration.");
      // Skip the first and last 10%.
      const start = duration * 0.1;
      const span = duration * 0.8;
      targets = Array.from({ length: count }, (_, i) =>
        count === 1 ? start + span / 2 : start + (span * i) / (count - 1),
      );
      video.currentTime = targets[0];
    };

    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      // Cap the long edge: a 4K frame is far more than any image model reads,
      // and the data URL has to survive a JSON request body.
      const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) return fail("This browser cannot render video frames.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.92));

      index += 1;
      if (index >= targets.length) {
        cleanup();
        resolve(frames);
        return;
      }
      video.currentTime = targets[index];
    };
  });
}

