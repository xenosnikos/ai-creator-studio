import os from "node:os";

import type { NextConfig } from "next";

/**
 * Every address this machine can be reached on, for `allowedDevOrigins`.
 *
 * Next 16 trusts only `localhost` for the dev server's internal endpoints.
 * Open the dev server on another address — `http://192.168.1.16:3000`, the
 * "Network:" URL it prints at startup, which is what you use to try the app on
 * a phone — and it refuses the requests behind hot reload:
 *
 *     Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr
 *
 * The page still renders, because that is plain server HTML. But the client
 * bundle never finishes starting, React never attaches, and every button and
 * input on the page silently stops working. Nothing appears in the browser
 * console and a production build is unaffected, which makes it about as hard to
 * diagnose as a bug gets.
 *
 * CIDR ranges do NOT work here — `192.168.0.0/16` is not matched against
 * `192.168.1.16`, which is why an earlier attempt at this failed. The entries
 * have to be hostnames. So rather than guessing, ask the OS for this machine's
 * own non-internal IPv4 addresses: they are exactly the ones the dev server
 * prints and the only ones a browser on the LAN can use to reach it.
 *
 * Wildcards are included as a fallback for an address that appears after the
 * server starts (a new Wi-Fi network, a VPN). All of it is private-range only,
 * unreachable from the internet, and ignored entirely by a production build.
 */
function localNetworkOrigins(): string[] {
  const origins = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        // Node 18+ reports family as "IPv4"; older builds used the number 4.
        const isIPv4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
        if (isIPv4 && !entry.internal) origins.add(entry.address);
      }
    }
  } catch {
    // Interface enumeration is best-effort; localhost still works regardless.
  }
  // Escape hatch for an address this cannot know about — a changed IP, a
  // tunnel host — without having to edit this file:
  //   EXTRA_DEV_ORIGINS=192.168.1.17,myhost.local npm run dev
  for (const extra of (process.env.EXTRA_DEV_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: localNetworkOrigins(),
  experimental: {
    // Reference photos are sent inline as base64 data URLs in the POST /api/projects
    // JSON body (up to 18 of them). Phone photos are commonly 3–8MB each and base64
    // adds ~33%, so the default 10MB proxy body cap truncated the JSON, the parse
    // failed, and creation 400'd after a long upload ("Failed to fetch" on mobile).
    // 64MB covers the worst case the form allows. Experimental key: the runtime
    // schema accepts it, the published types lag it (verified in node_modules).
    proxyClientMaxBodySize: "64mb" as unknown as never,
  },
  // Emit a self-contained server bundle so the Docker image can ship without
  // the full node_modules tree.
  output: "standalone",
  // Node core SQLite is the default backend (no compilation, any platform).
  // better-sqlite3 is only an optional fallback for Node < 22.5; keep it
  // external so its native binary is never bundled.
  //
  // `ffmpeg-static` is external for the same reason and a sharper one: its
  // whole export is a filesystem path to a binary. Bundled, that path resolves
  // against a build chunk instead of node_modules, the lookup fails, and the
  // code falls back to an `ffmpeg` on PATH that is usually not there. The
  // failure is silent by design — joining shots is best-effort — so the visible
  // symptom is a finished project that hands back separate clips, each still
  // carrying the trailing silence the trim would have removed.
  //
  // It also explains why `npm run doctor` can pass while the app cannot find
  // it: the doctor runs under plain Node, where the require resolves fine. Only
  // the server runtime is affected, which is the one that matters.
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  images: {
    // Generated assets are proxied through /api/assets, but provider CDNs are
    // also referenced directly while a job is still in flight.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
