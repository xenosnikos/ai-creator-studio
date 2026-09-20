"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "@/lib/client";

/**
 * Delete a creator or project from its card in the list.
 *
 * Deleting used to mean opening the item first, finding the button in its
 * header, and coming back — three navigations to remove something you can see
 * from where you are standing. Clearing out a library of trial creators that
 * way is tedious enough that people leave the clutter instead.
 *
 * It sits *inside* a card that is itself a link, so the click has to be
 * stopped from bubbling or the browser follows the link on the way to the
 * confirm dialog.
 */
export function DeleteButton({
  endpoint,
  label,
  confirmText,
}: {
  /** API path to DELETE, e.g. `/api/creators/crt_123`. */
  endpoint: string;
  /** Screen-reader name, e.g. "Delete Mia Tanaka". */
  label: string;
  /** What the confirm dialog asks. Spell out what is lost. */
  confirmText: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!confirm(confirmText)) return;
        setBusy(true);
        try {
          await api(endpoint, { method: "DELETE" });
          router.refresh();
        } catch (cause) {
          alert(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }}
      className="btn btn-icon btn-ghost btn-danger opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
    >
      {busy ? (
        <span className="text-[10px]">…</span>
      ) : (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path
            d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4M6.5 7v4M9.5 7v4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
