"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/client";

interface Health {
  providers: Record<string, { provider: string; ready: boolean }>;
}

/**
 * Shows which stages are wired up. A reviewer needs to know instantly whether
 * they are looking at real generations or offline placeholders.
 *
 * Names the stage and its credential, never the underlying model — that is an
 * implementation detail and is not shipped to the browser at all.
 */
export function ProviderBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<Health>("/api/health")
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  if (!health) return null;

  const entries = Object.entries(health.providers);
  const mocked = entries.filter(([, value]) => value.provider === "mock");
  const broken = entries.filter(([, value]) => !value.ready);

  const tone =
    broken.length > 0
      ? "border-red-400/40 bg-red-400/10 text-red-200"
      : mocked.length > 0
        ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
        : "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";

  const label =
    broken.length > 0
      ? `${broken.length} provider${broken.length > 1 ? "s" : ""} not configured`
      : mocked.length > 0
        ? `${mocked.length} mock provider${mocked.length > 1 ? "s" : ""}`
        : "Live providers";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${tone}`}
      >
        {label}
      </button>
      {open ? (
        <div className="panel absolute right-0 top-9 z-30 w-80 p-3 text-xs shadow-xl">
          <p className="mb-2 font-semibold text-slate-200">Stages</p>
          <ul className="space-y-1.5">
            {entries.map(([kind, value]) => (
              <li key={kind} className="flex items-center justify-between gap-3">
                <span className="capitalize text-muted">{kind}</span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-slate-300">{value.provider}</span>
                  <span className={value.ready ? "text-emerald-400" : "text-red-400"}>
                    {value.ready ? "●" : "●"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="btn btn-sm mt-3 w-full"
          >
            {mocked.length > 0 || broken.length > 0 ? "Add API keys" : "Manage keys & providers"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
