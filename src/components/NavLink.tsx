"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A nav item that knows whether it is the current section.
 *
 * The header previously gave every link the same treatment, so the only way to
 * tell where you were was to read the page title. On a three-section app that
 * is survivable and still wrong — the navigation is the one component present
 * on every screen, and it was the one component carrying no state.
 */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative rounded-lg px-3 py-1.5 transition duration-150 ${
        active ? "text-slate-100" : "text-muted hover:bg-raised hover:text-slate-200"
      }`}
    >
      {children}
      {/* An underline rather than a filled pill: the header is dense, and a
          filled state would compete with the primary action for attention. */}
      {active ? (
        <span className="absolute inset-x-3 -bottom-[13px] h-px bg-accent" aria-hidden />
      ) : null}
    </Link>
  );
}
