"use client";

import { useEffect, useState } from "react";

/**
 * Says so, loudly, when the page's JavaScript never started.
 *
 * This exists because of a genuinely baffling failure mode. If Next's dev
 * bootstrap fails — most commonly because the dev server was opened from an
 * address that is not in `allowedDevOrigins`, which blocks the hot-reload
 * connection — the server HTML still renders perfectly. The page looks
 * completely normal and nothing appears in the browser console. But React never
 * attaches, so every button, input and link handler is inert. Typing into a
 * field does nothing, and buttons show a "not allowed" cursor because their
 * server-rendered `disabled` state can never update.
 *
 * The trick is that this banner is rendered by *default* and removed by an
 * effect. An effect only runs if React actually mounted — so if the page is
 * dead, the banner stays up and names the cause. A warning that depended on
 * JavaScript running would be invisible in exactly the case it is needed.
 *
 * Development only, and that is not a detail. Rendering by default means every
 * visitor sees this for however long the JavaScript bundle takes to arrive —
 * which on a phone, over a tunnel, is seconds of alarming orange text at the
 * top of the first page a reviewer ever loads. The failure it describes is
 * dev-only anyway: `allowedDevOrigins` gates the dev server's hot-reload
 * bootstrap, and a production build has no such bootstrap to block. Warning
 * about it in production is a false alarm with instructions that do not apply.
 */
export function HydrationGuard() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (mounted || process.env.NODE_ENV === "production") return null;

  return (
    <div
      // Hidden for anyone who has JS switched off entirely: that is a different
      // problem, and this message would only mislead them.
      className="note note-warn mx-auto mb-4 max-w-7xl"
      role="alert"
    >
      <strong className="font-semibold">This page is not interactive yet.</strong>{" "}
      If this message does not clear in a moment, the page&apos;s JavaScript never
      started and no button on it will respond.
      <br />
      <br />
      In development this means the address you are using is not trusted by the dev
      server — check its terminal for{" "}
      <span className="font-mono text-[0.95em]">Blocked cross-origin request</span>. The
      quickest fix is to open{" "}
      <a className="font-mono underline" href="http://localhost:3000">
        http://localhost:3000
      </a>{" "}
      instead, which always works on the machine running the server. To keep using an
      IP address, restart <span className="font-mono text-[0.95em]">npm run dev</span>{" "}
      (the trusted list is read at startup, so it goes stale when your IP changes), or
      start it as{" "}
      <span className="font-mono text-[0.95em]">
        EXTRA_DEV_ORIGINS=&lt;that address&gt; npm run dev
      </span>
      .
    </div>
  );
}
