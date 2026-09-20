import fs from "node:fs/promises";
import path from "node:path";

import { config } from "@/lib/config";

/**
 * Asset persistence.
 *
 * Provider result URLs expire (KIE temp storage is ~3 days). Everything we
 * generate is therefore mirrored into DATA_DIR/assets immediately and served
 * back through /api/assets, so a project stays reviewable indefinitely and the
 * export bundle is self-contained.
 */

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
};

export interface StoredAsset {
  /** Path relative to the assets dir; also the /api/assets route param. */
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  bytes: number;
}

function extensionFor(mimeType: string, sourceUrl: string): string {
  const known = EXTENSION_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()];
  if (known) return known;
  const fromUrl = path.extname(new URL(sourceUrl, "https://placeholder.local").pathname);
  return fromUrl ? fromUrl.replace(".", "") : "bin";
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "asset";
}

/** Backoff between download attempts. */
const DOWNLOAD_RETRY_DELAYS_MS = [1000, 3000, 8000];

/**
 * Fetch a provider result, retrying transient failures.
 *
 * Generated assets sit on CDNs that intermittently return 5xx for a file that
 * was created seconds earlier. Losing a render that the provider already
 * charged for — because of a blip on the *download* — is the worst possible
 * failure, so this retries where the rest of the pipeline does.
 */
/**
 * Refuse to fetch anything that is not a public web address.
 *
 * This function downloads URLs the operator supplied, and one of the places
 * they can be supplied is a creator's reference list. Without this check the
 * app is a working server-side request forgery: pointing a reference at
 * `http://127.0.0.1:.../api/health` made the server fetch it, write the JSON
 * response into the assets directory, and serve it straight back over
 * `/api/assets/...`. Anything the server can reach — a metadata endpoint, a
 * database admin page, another service on the same network — could be read by
 * anyone who could reach the app. Since the app has no authentication and is
 * routinely put behind a public tunnel, "anyone who could reach the app" is
 * whoever has the link.
 *
 * Hostnames are resolved before the verdict rather than pattern-matched, so a
 * public name that points at a private address does not slip through.
 */
async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https references can be downloaded, not ${url.protocol}`);
  }

  const { lookup } = await import("node:dns/promises");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${url.hostname}`);
  }
  const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
  if (blocked) {
    throw new Error(
      `Refusing to download from ${url.hostname}: it resolves to the private address ` +
        `${blocked.address}. References must be public URLs.`,
    );
  }
}

/** Loopback, link-local, and the RFC1918 / unique-local ranges. */
function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::" || v6 === "::1") return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
  // IPv4 written inside an IPv6 address, e.g. ::ffff:127.0.0.1
  const mapped = /(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function download(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  await assertPublicUrl(url);
  let lastError = "";
  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return {
          mimeType: response.headers.get("content-type") ?? "application/octet-stream",
          bytes: Buffer.from(await response.arrayBuffer()),
        };
      }
      lastError = `HTTP ${response.status}`;
      // A 4xx means the URL is wrong or expired; retrying cannot help.
      if (response.status >= 400 && response.status < 500) break;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    if (attempt < DOWNLOAD_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new Error(`Failed to download asset (${lastError}) from ${url}`);
}

/**
 * Download (or decode) a URL into local storage.
 * Handles both real provider URLs and the `data:` URLs the mock providers emit.
 */
export async function persistFromUrl(
  url: string,
  folder: string,
  baseName: string,
): Promise<StoredAsset> {
  let bytes: Buffer;
  let mimeType: string;

  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!match) throw new Error("Malformed data URL");
    mimeType = match[1];
    bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
  } else {
    const downloaded = await download(url);
    mimeType = downloaded.mimeType;
    bytes = downloaded.bytes;
  }

  const relativePath = path.posix.join(
    safeSegment(folder),
    `${safeSegment(baseName)}.${extensionFor(mimeType, url)}`,
  );
  const absolutePath = path.join(config.assetsDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);

  return { relativePath, absolutePath, mimeType, bytes: bytes.length };
}

/** Write raw bytes (e.g. an uploaded reference photo) into local storage. */
export async function persistBytes(
  bytes: Buffer,
  folder: string,
  fileName: string,
): Promise<StoredAsset> {
  const relativePath = path.posix.join(safeSegment(folder), safeSegment(fileName));
  const absolutePath = path.join(config.assetsDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);
  return {
    relativePath,
    absolutePath,
    mimeType: "application/octet-stream",
    bytes: bytes.length,
  };
}

/**
 * Absolute path of a stored asset, for tools that work on files rather than
 * bytes (ffmpeg). Guards traversal the same way readAsset does.
 */
export function absoluteAssetPath(relativePath: string): string {
  const resolved = path.resolve(path.join(config.assetsDir, relativePath));
  if (!resolved.startsWith(path.resolve(config.assetsDir) + path.sep)) {
    throw new Error("Refusing to touch a path outside the assets directory");
  }
  return resolved;
}

/**
 * Delete a whole asset folder — everything one project or one creator produced.
 *
 * Deleting a project used to remove its rows and leave its files. The rows
 * cascade, so nothing in the app could still see them, and a thirty-second
 * render is tens of megabytes: a few weeks of ordinary use filled the disk with
 * video that no longer belonged to anything and that no screen would ever show.
 * On a hosted volume that is a bill, and the only way to find it was to go
 * looking on disk.
 *
 * Never throws. The DB row is gone by the time this runs and re-running the
 * delete is not possible, so failing here would only turn a leaked folder into
 * a failed request that leaks the folder anyway.
 */
export async function removeAssetFolder(folder: string): Promise<void> {
  try {
    const resolved = path.resolve(path.join(config.assetsDir, safeSegment(folder)));
    // The same traversal guard as everywhere else, and it matters more here:
    // this call is recursive and does not stop at the first error.
    if (!resolved.startsWith(path.resolve(config.assetsDir) + path.sep)) return;
    await fs.rm(resolved, { recursive: true, force: true });
  } catch {
    // A folder that cannot be removed is disk to reclaim later, not a failed
    // deletion to report.
  }
}

export async function readAsset(relativePath: string): Promise<Buffer> {
  const absolutePath = path.join(config.assetsDir, relativePath);
  // Guard against traversal via a crafted /api/assets path.
  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(path.resolve(config.assetsDir) + path.sep)) {
    throw new Error("Refusing to read outside the assets directory");
  }
  return fs.readFile(resolved);
}

export function publicUrlFor(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  return `/api/assets/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

export function mimeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).replace(".", "").toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
