"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/client";
import type { Job } from "@/lib/types";

const LABELS: Record<string, string> = {
  storyboard: "Storyboard + script",
  identity_sheet: "Identity sheet",
  creator_bootstrap: "Seed portrait",
  scene_image: "Scene keyframe",
  scene_video: "Scene clip",
  scene_voice: "Voice-over",
  project_cut: "Final cut",
};

/**
 * Polls the job feed and reports when work finishes so the parent can refresh.
 * Polling (rather than websockets) keeps the POC to a single process with no
 * extra infrastructure.
 */
export function JobFeed({
  projectId,
  creatorId,
  onSettled,
}: {
  projectId?: string;
  creatorId?: string;
  onSettled?: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const previousActive = useRef(0);

  async function cancelOne(id: string) {
    setCancelling((current) => new Set(current).add(id));
    try {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
    } catch {
      // The next poll shows the real state either way.
    }
  }

  async function cancelAll() {
    try {
      await api("/api/jobs/all/cancel", {
        method: "POST",
        body: JSON.stringify(projectId ? { projectId } : { creatorId }),
      });
    } catch {
      // Same: the feed re-reads state on its own.
    }
  }

  useEffect(() => {
    let cancelled = false;
    let currentEvery = 2500;
    const query = projectId
      ? `?projectId=${projectId}`
      : creatorId
        ? `?creatorId=${creatorId}`
        : "";

    async function poll() {
      try {
        const data = await api<{ jobs: Job[] }>(`/api/jobs${query}`);
        if (cancelled) return;
        setJobs(data.jobs);

        const active = data.jobs.filter(
          (job) => job.status === "queued" || job.status === "running",
        ).length;
        // Clear the local "cancelling" marks once the server agrees.
        setCancelling((current) => {
          if (current.size === 0) return current;
          const stillPending = new Set(
            data.jobs
              .filter((job) => current.has(job.id) && job.status === "running")
              .map((job) => job.id),
          );
          return stillPending.size === current.size ? current : stillPending;
        });
        // Fire once on the falling edge: work was in flight, now it isn't.
        if (previousActive.current > 0 && active === 0) onSettled?.();
        previousActive.current = active;
      } catch {
        // Transient poll failures are not worth surfacing.
      }
    }

    void poll();
    // 2.5s while work is in flight; 15s when idle. The feed used to poll at a
    // fixed 2.5s forever, which floods the server log on a page nobody is
    // rendering from and buys nothing.
    let interval = setInterval(poll, 2500);
    const retune = setInterval(() => {
      const wanted = previousActive.current > 0 ? 2500 : 15000;
      if (wanted === currentEvery) return;
      currentEvery = wanted;
      clearInterval(interval);
      interval = setInterval(poll, wanted);
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(retune);
    };
  }, [projectId, creatorId, onSettled]);

  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const failed = jobs.filter((job) => job.status === "failed").slice(0, 4);
  const cancelled = jobs.filter((job) => job.status === "cancelled").slice(0, 3);

  if (active.length === 0 && failed.length === 0 && cancelled.length === 0) return null;

  return (
    <div className="panel space-y-2 p-3 text-xs">
      {active.length > 0 ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="font-semibold text-slate-200">
              {active.length} job{active.length > 1 ? "s" : ""} in progress
            </p>
            {active.length > 1 ? (
              <button type="button" onClick={cancelAll} className="btn btn-sm btn-ghost btn-danger">
                Cancel all
              </button>
            ) : null}
          </div>
          <ul className="space-y-1.5">
            {active.slice(0, 6).map((job) => (
              <li key={job.id}>
                <div className="flex items-center justify-between gap-2 text-muted">
                  <span>{LABELS[job.type] ?? job.type}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono">
                      {job.status === "queued" ? "queued" : `${job.progress}%`}
                    </span>
                    <button
                      type="button"
                      onClick={() => cancelOne(job.id)}
                      disabled={cancelling.has(job.id)}
                      title={
                        job.status === "queued"
                          ? "Stop this before it starts — costs nothing"
                          : "Stop waiting on this. The render is already running at the provider and is billed either way."
                      }
                      className="btn btn-sm btn-ghost btn-danger px-1.5 py-0.5"
                    >
                      {cancelling.has(job.id) ? "…" : "Cancel"}
                    </button>
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-edge">
                  <div
                    className="h-full rounded-full bg-emerald-400/70 transition-all"
                    style={{ width: `${job.status === "queued" ? 3 : job.progress}%` }}
                  />
                </div>
              </li>
            ))}
            {active.length > 6 ? (
              <li className="text-muted">…and {active.length - 6} more</li>
            ) : null}
          </ul>
        </>
      ) : null}

      {cancelled.length > 0 ? (
        <div className="space-y-1 border-t border-edge pt-2 text-muted">
          <p className="font-semibold text-slate-300">Cancelled</p>
          {cancelled.map((job) => (
            <p key={job.id}>{LABELS[job.type] ?? job.type}</p>
          ))}
        </div>
      ) : null}

      {failed.length > 0 ? (
        <div className="space-y-1 border-t border-edge pt-2">
          <p className="font-semibold text-red-300">Recent failures</p>
          {failed.map((job) => (
            <p key={job.id} className="text-red-300/80">
              <span className="font-medium">{LABELS[job.type] ?? job.type}:</span> {job.error}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
