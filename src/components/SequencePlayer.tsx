"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Plays a project's clips back to back as one piece.
 *
 * The pipeline renders a shot at a time — the video model tops out at fifteen
 * seconds — so a thirty-second brief comes back as three files. Showing three
 * players is showing the operator the plumbing; what they asked for is the
 * video.
 *
 * Stitching them into a single file would need ffmpeg, which this app treats
 * as optional and most machines running it do not have. Playing them in
 * sequence gets the same result in the one place it matters — watching it —
 * without adding a hard dependency to the critical path.
 */
export function SequencePlayer({
  clips,
  aspectRatio,
}: {
  clips: Array<{ id: string; url: string; title: string }>;
  /** e.g. "9:16" — keeps the frame the right shape before anything loads. */
  aspectRatio: string;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [w, h] = aspectRatio.split(":").map(Number);
  const current = clips[index];

  // Autoplay each subsequent clip, but never the first — a page that starts
  // making noise on load is a page people close.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    void video.play().catch(() => setPlaying(false));
  }, [index, playing]);

  if (clips.length === 0) return null;

  return (
    <div className="space-y-3">
      <div
        className="relative mx-auto overflow-hidden rounded-[var(--radius-lg)] border border-edge bg-black"
        style={{ aspectRatio: `${w || 9} / ${h || 16}`, maxHeight: "70vh" }}
      >
        <video
          ref={videoRef}
          key={current.id}
          src={current.url}
          controls
          playsInline
          className="h-full w-full object-contain"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            if (index < clips.length - 1) setIndex(index + 1);
            else setPlaying(false);
          }}
        />
      </div>

      {clips.length > 1 ? (
        <div className="flex items-center justify-center gap-1.5">
          {clips.map((clip, i) => (
            <button
              key={clip.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Shot ${i + 1}: ${clip.title}`}
              aria-current={i === index ? "true" : undefined}
              title={clip.title}
              className={`h-1 rounded-full transition-all duration-300 ${
                i === index ? "w-8 bg-accent" : "w-4 bg-edge-strong hover:bg-muted"
              }`}
            />
          ))}
          <span className="ml-2 text-[11px] text-faint">
            shot {index + 1} of {clips.length}
          </span>
        </div>
      ) : null}
    </div>
  );
}
