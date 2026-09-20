import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";
import { HydrationGuard } from "@/components/HydrationGuard";
import { NavLink } from "@/components/NavLink";
import { ProviderBadge } from "@/components/ProviderBadge";

export const metadata: Metadata = {
  title: "AI Creator Studio",
  description:
    "Proof of concept: generate social content with consistent AI creators — identity, voice and style preserved across images and video.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="sticky top-0 z-20 border-b border-edge bg-ink/70 backdrop-blur-xl">
            <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
              <Link
                href="/"
                className="group flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-[-0.02em] transition hover:opacity-90"
              >
                {/* A drawn mark rather than a text glyph: "▶" rendered at a
                    different weight and baseline in every browser, which made
                    the one persistent element on the page the least consistent
                    one. */}
                <span className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-accent/[0.14] text-accent ring-1 ring-accent/25 transition group-hover:bg-accent/25">
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden>
                    <path d="M5.2 3.4a.8.8 0 0 1 1.22-.68l6.1 3.9a.8.8 0 0 1 0 1.35l-6.1 3.9A.8.8 0 0 1 5.2 11.2V3.4Z" />
                  </svg>
                </span>
                AI Creator Studio
              </Link>
              <nav className="flex items-center gap-0.5 text-sm">
                <NavLink href="/creators">Creators</NavLink>
                <NavLink href="/projects">Projects</NavLink>
                <NavLink href="/settings">Settings</NavLink>
              </nav>
              <div className="ml-auto">
                <ProviderBadge />
              </div>
            </div>
          </header>
          <div className="px-6 pt-4">
            <HydrationGuard />
          </div>
          <main className="animate-in mx-auto max-w-7xl px-6 pb-16 pt-7">{children}</main>
        </div>
      </body>
    </html>
  );
}
