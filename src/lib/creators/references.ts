import { createHash } from "node:crypto";

import sharp from "sharp";

import { imageProvider } from "@/lib/providers/registry";
import { creators } from "@/lib/repo";
import { mimeForPath, persistFromUrl, readAsset } from "@/lib/storage";
import type { CreatorReference, IdentityAngle } from "@/lib/types";

const REFERENCE_MAX_SIDE = 2048;
const REFERENCE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Best-effort reference sizing; durable originals are never rewritten.
 * Small images and SVG placeholders pass through unchanged. Oversized rasters
 * become JPEGs, auto-oriented and flattened onto white.
 * This is not validation: unreadable input (or a processing failure) forwards
 * the original bytes and declared MIME for the provider to judge.
 */
export async function referenceReady(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (mimeType.includes("svg")) return { bytes, mimeType };
  try {
    const { width = 0, height = 0 } = await sharp(bytes).metadata();
    if (Math.max(width, height) <= REFERENCE_MAX_SIDE && bytes.length <= REFERENCE_MAX_BYTES) {
      return { bytes, mimeType };
    }
    const resized = await sharp(bytes)
      .rotate()
      .resize({
        width: REFERENCE_MAX_SIDE,
        height: REFERENCE_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { bytes: resized, mimeType: "image/jpeg" };
  } catch {
    return { bytes, mimeType };
  }
}

/** Upload an image as a model reference, right-sized first. */
async function uploadReference(bytes: Buffer, fileName: string, mimeType: string): Promise<string> {
  const ready = await referenceReady(bytes, mimeType);
  const name =
    ready.mimeType === mimeType ? fileName : `${fileName.replace(/\.[a-z0-9]+$/i, "")}.jpg`;
  return imageProvider().uploadImage(ready.bytes, name, ready.mimeType);
}

/** Refresh well inside KIE's temporary-URL lifetime. */
const PROVIDER_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

const creatorUploads = new Map<
  string,
  { expiresAt: number; upload: Promise<CreatorReference> }
>();
const contextUploads = new Map<string, { expiresAt: number; upload: Promise<string> }>();

/**
 * Reference intake.
 *
 * A reference needs to exist in two places: locally (so the project survives
 * provider URL expiry and the export bundle is self-contained) and at a URL the
 * image model can fetch (so it can actually condition on it). This does both
 * and records the pair.
 */
export async function persistReference(input: {
  creatorId: string;
  /** A data URL from a browser upload, or an existing https URL. */
  source: string;
  kind: CreatorReference["kind"];
  angle?: IdentityAngle | null;
  isAnchor: boolean;
}): Promise<CreatorReference> {
  const stored = await persistFromUrl(
    input.source,
    `creators/${input.creatorId}`,
    `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  // Always re-host the durable local copy. A remote source URL can expire,
  // reject server-to-server access, or be readable by this app but not by the
  // image provider. Passing it through unchanged made an uploaded creator look
  // present in the UI while the model silently rendered without that person.
  const bytes = await readAsset(stored.relativePath);
  const remoteUrl = await uploadReference(
    bytes,
    stored.relativePath.split("/").pop() ?? "reference.png",
    stored.mimeType,
  );

  return creators.addReference({
    creatorId: input.creatorId,
    kind: input.kind,
    angle: input.angle ?? null,
    remoteUrl,
    localPath: stored.relativePath,
    isAnchor: input.isAnchor,
  });
}

/**
 * Re-upload every creator reference from its durable local file before it can
 * condition a paid image render.
 *
 * Provider URLs are temporary. A stale URL is especially dangerous here: the
 * generation request may still succeed, but without the image that defines the
 * face. Failing before submission is preferable to billing for a stranger.
 * A single-flight cache prevents parallel scene jobs from uploading the same
 * files repeatedly.
 */
export async function providerReadyCreatorReferences(
  references: CreatorReference[],
): Promise<CreatorReference[]> {
  const provider = imageProvider();
  if (provider.name === "mock") return references;

  return Promise.all(
    references.map(async (reference) => {
      if (!reference.localPath) {
        throw new Error(
          `Creator reference ${reference.id} has no durable local file. Re-upload that creator photo before rendering.`,
        );
      }

      const key = `${provider.name}:${reference.id}`;
      const cached = creatorUploads.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.upload;

      const upload = (async () => {
        const bytes = await readAsset(reference.localPath!);
        const remoteUrl = await uploadReference(
          bytes,
          reference.localPath!.split("/").pop() ?? `${reference.id}.png`,
          mimeForPath(reference.localPath!),
        );
        return (
          creators.updateReferenceRemoteUrl(reference.id, remoteUrl) ?? {
            ...reference,
            remoteUrl,
          }
        );
      })().catch((error) => {
        creatorUploads.delete(key);
        throw error;
      });

      creatorUploads.set(key, {
        expiresAt: Date.now() + PROVIDER_UPLOAD_TTL_MS,
        upload,
      });
      return upload;
    }),
  );
}

/**
 * Make uploaded wardrobe/location/style images provider-readable as well.
 * Project forms store these as data URLs, which are not public URLs and should
 * never be handed directly to a remote model.
 */
export async function providerReadyContextReferences(
  sources: string[],
  namespace: string,
): Promise<string[]> {
  const provider = imageProvider();

  return Promise.all(
    sources.map(async (source, index) => {
      const digest = createHash("sha256").update(source).digest("hex").slice(0, 20);
      const key = `${provider.name}:${digest}`;
      const cached = contextUploads.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.upload;

      const upload = (async () => {
        const decoded = await referenceBytes(source);
        const extension = extensionForMime(decoded.mimeType);
        return uploadReference(
          decoded.bytes,
          `${namespace}-${index + 1}-${digest}.${extension}`,
          decoded.mimeType,
        );
      })().catch((error) => {
        contextUploads.delete(key);
        throw error;
      });

      contextUploads.set(key, {
        expiresAt: Date.now() + PROVIDER_UPLOAD_TTL_MS,
        upload,
      });
      return upload;
    }),
  );
}

/**
 * Re-host an image asset that the app already persisted locally.
 *
 * Generated still URLs are temporary too. Appearance continuity may reuse
 * scene 1 days later, so depending on its original provider URL would make the
 * lock disappear precisely on re-renders of older projects.
 */
export async function providerReadyStoredReference(
  localPath: string,
  namespace: string,
): Promise<string> {
  const provider = imageProvider();
  const key = `${provider.name}:stored:${localPath}`;
  const cached = contextUploads.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.upload;

  const upload = (async () => {
    const bytes = await readAsset(localPath);
    return uploadReference(
      bytes,
      `${namespace}-${localPath.split("/").pop() ?? "reference.jpg"}`,
      mimeForPath(localPath),
    );
  })().catch((error) => {
    contextUploads.delete(key);
    throw error;
  });

  contextUploads.set(key, {
    expiresAt: Date.now() + PROVIDER_UPLOAD_TTL_MS,
    upload,
  });
  return upload;
}

async function referenceBytes(
  source: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (source.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source);
    if (!match) throw new Error("Malformed uploaded reference image");
    return {
      mimeType: match[1],
      bytes: match[2]
        ? Buffer.from(match[3], "base64")
        : Buffer.from(decodeURIComponent(match[3]), "utf8"),
    };
  }

  if (!source.startsWith("http://") && !source.startsWith("https://")) {
    throw new Error("A project reference is neither an uploaded image nor a public URL");
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Could not download project reference (HTTP ${response.status})`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
  };
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}
