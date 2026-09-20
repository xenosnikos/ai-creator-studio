/**
 * One-command share: build, start with a password, open a public tunnel.
 *
 *   npm run share
 *
 * Prints the URL and password to hand to a reviewer. Ctrl-C stops both the
 * server and the tunnel.
 *
 * Everything here can be done by hand (see docs/DEPLOY.md); this exists because
 * doing it by hand means two terminals, platform-specific environment-variable
 * syntax, and remembering to set a password at all.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Read SHARE_PASSWORD out of .env.local if it is set there. Done by hand rather
 * than with tsx's --env-file-if-exists, whose "not found" notice reads like an
 * error to someone running this for the first time.
 */
function passwordFromEnvFile(): string | undefined {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const match = /^\s*SHARE_PASSWORD\s*=\s*(.*)$/m.exec(text);
    return match?.[1].trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Readable but not guessable — this is the only thing protecting the app. */
function generatePassword(): string {
  const words = [
    "amber", "basalt", "cedar", "delta", "ember", "flint", "granite", "harbor",
    "indigo", "juniper", "kelp", "lumen", "marble", "nimbus", "onyx", "pumice",
    "quartz", "ridge", "slate", "tundra", "umber", "vellum", "willow", "zephyr",
  ];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}

const children: ChildProcess[] = [];
let shuttingDown = false;

/**
 * Takes one whole command line rather than a command plus an args array:
 * Windows needs shell:true to resolve npm/npx (they are .cmd shims), and
 * combining shell:true with an args array is deprecated in Node 22+ (DEP0190).
 * Every command line here is a static literal — no user input is interpolated,
 * and secrets travel via env only.
 */
function run(commandLine: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(commandLine, {
    shell: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForServer(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      // 401 means the password gate is active — the server is up, which is
      // exactly what we are waiting for.
      if (response.ok || response.status === 401) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function build(): Promise<number> {
  return new Promise((resolve) => {
    const child = run("npm run build");
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Compiled successfully|Failed/.test(text)) process.stdout.write(`  ${text.trim()}\n`);
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Build once; if that fails, wipe every build artifact and build again before
 * giving up.
 *
 * The retry is not superstition. `.next` holds generated type definitions and a
 * compiler cache written by whichever command ran last, and an interrupted
 * `next dev` leaves them truncated — after which every build fails inside a
 * file the operator never wrote, with no hint that deleting a directory is the
 * cure. `npm run build` now clears the dev types on its own, so a second
 * attempt from a genuinely clean slate is the only remaining recovery, and it
 * costs a minute at the point where the alternative is handing someone a stack
 * trace and no link.
 */
async function buildIfNeeded(): Promise<void> {
  if (fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) return;

  console.log("Building the app (first time only, ~1 minute)…");
  if ((await build()) === 0) return;

  console.log("\nBuild failed. Clearing the build cache and trying once more…");
  fs.rmSync(path.join(process.cwd(), ".next"), { recursive: true, force: true });
  if ((await build()) === 0) return;

  throw new Error(
    "Build failed twice, so the error above is in the project itself, not a stale cache.",
  );
}

async function main(): Promise<void> {
  const password =
    process.env.SHARE_PASSWORD?.trim() || passwordFromEnvFile() || generatePassword();

  await buildIfNeeded();

  console.log("Starting the app…");
  const server = run("npm run start", {
    SHARE_PASSWORD: password,
    PORT: String(PORT),
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/EADDRINUSE/.test(text)) {
      console.error(
        `\nSomething is already using port ${PORT}.\n` +
          `Close it, or run:  PORT=${PORT + 1} npm run share\n`,
      );
      shutdown(1);
    }
  });
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\nThe app stopped unexpectedly (exit ${code}).`);
      shutdown(1);
    }
  });

  if (!(await waitForServer())) {
    console.error("\nThe app did not start in time. Try `npm run dev` to see the error.");
    shutdown(1);
    return;
  }
  // Print the password here, not only alongside the tunnel URL. The tunnel can
  // take minutes or fail outright, and until then the local address is gated by
  // a password the user has not been shown — which reads as the app being broken.
  console.log(
    [
      "",
      `  Running at ${BASE_URL}  —  password: ${password}`,
      "  Usable right now; the public link below is only needed to share it.",
      "",
    ].join("\n"),
  );

  const lan = lanAddress();
  if (lan) {
    console.log(
      [
        `  On the same office or home network, this already works from another`,
        `  machine — no public link needed:  http://${lan}:${PORT}`,
        "",
      ].join("\n"),
    );
  }

  const url = await openTunnel();
  if (url) {
    announce(url, password);
    return;
  }

  console.log(
    [
      "",
      `Could not open a public link — every tunnel service was unreachable.`,
      "That is a firewall or network restriction on this machine, not a fault",
      "in the app: it is running fine at the address above.",
      "",
      "Three ways forward, cheapest first:",
      "",
      lan
        ? `  1. Same network — send  http://${lan}:${PORT}  and the password. Anyone`
        : `  1. Same network — run  ipconfig  (Windows) or  ifconfig  (Mac) to find`,
      lan
        ? "     in the same office or house can open that today."
        : `     this machine's address, then send  http://THAT-ADDRESS:${PORT}.`,
      "",
      "  2. Off a corporate network — a phone hotspot usually lets the tunnel",
      "     through, since it is the office firewall that blocks it.",
      "",
      "  3. A permanent link that never depends on your network — host it.",
      "     See docs/DEPLOY.md; Railway is the shortest path.",
      "",
      `The app stays running at ${BASE_URL} (password: ${password}) until you`,
      "close this window.",
      "",
    ].join("\n"),
  );
}

/**
 * Tunnel services, tried in order until one yields a URL.
 *
 * There is more than one because a quick tunnel is the step most likely to fail
 * on someone else's machine, and it fails for reasons the operator cannot fix:
 * corporate firewalls block the UDP that Cloudflare's client prefers, some
 * networks blackhole the provider outright, and a free service can simply be
 * down. Each provider reaches the internet differently, so one being blocked
 * says little about the next.
 *
 * All three are third-party relays that see the traffic in transit. That is
 * the deal with any quick tunnel; it is why the app is behind a password before
 * a tunnel is ever opened, and why docs/DEPLOY.md exists for anything beyond a
 * demo.
 */
const TUNNELS = [
  {
    name: "Cloudflare",
    command: `npx -y untun@latest tunnel ${BASE_URL}`,
    pattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  },
  {
    name: "Tunnelmole",
    command: `npx -y tunnelmole@2 ${PORT}`,
    pattern: /https:\/\/[a-z0-9-]+\.tunnelmole\.net/i,
  },
  {
    name: "localtunnel",
    command: `npx -y localtunnel@2 --port ${PORT}`,
    pattern: /https:\/\/[a-z0-9-]+\.loca\.lt/i,
  },
];

/** How long one provider gets before we move on. */
const TUNNEL_TIMEOUT_MS = 90_000;

async function openTunnel(): Promise<string | null> {
  for (const [index, tunnel] of TUNNELS.entries()) {
    const first = index === 0;
    console.log(
      first
        ? `Opening a public link via ${tunnel.name}… (first run downloads it, ~1-3 min)`
        : `Trying ${tunnel.name} instead…`,
    );

    const url = await raceTunnel(tunnel);
    if (url) return url;

    console.log(`  ${tunnel.name} did not come up.`);
  }
  return null;
}

/** Start one provider; resolve with its URL, or null if it dies or stalls. */
function raceTunnel(tunnel: (typeof TUNNELS)[number]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = run(tunnel.command);
    let settled = false;

    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(patience);
      // A failed provider must not be left holding the port or the terminal.
      if (!url) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
      resolve(url);
    };

    const scan = (chunk: Buffer) => {
      const match = tunnel.pattern.exec(chunk.toString());
      if (match) finish(match[0]);
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("exit", () => finish(null));
    child.on("error", () => finish(null));

    const timer = setTimeout(() => finish(null), TUNNEL_TIMEOUT_MS);

    // Say something before the timeout, so a slow download does not read as a hang.
    const patience = setTimeout(() => {
      if (!settled) {
        console.log(
          `  still waiting on ${tunnel.name} — repeated 'downloading' lines are it\n` +
            `  fetching itself, which is normal. ${BASE_URL} already works meanwhile.`,
        );
      }
    }, 40_000);
  });
}

/**
 * This machine's address on its own network, when it has an ordinary one.
 *
 * Worth printing before any tunnel is attempted: a reviewer sitting in the same
 * office needs no public link at all, and this path cannot be blocked by the
 * firewall that breaks the tunnels.
 */
function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // Private ranges only: a public IPv4 on the host would be a server, and
      // telling someone to hand that address out is a different decision.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

function announce(url: string, password: string): void {
  const line = "─".repeat(58);
  console.log(
    [
      "",
      line,
      "  READY — send these two things to whoever is testing:",
      "",
      `    Link:      ${url}`,
      `    Password:  ${password}`,
      "",
      "  The browser asks for a username too — anything works.",
      "",
      "  Keep this window open. Closing it, or letting your computer",
      "  sleep, takes the link offline.",
      line,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
});
