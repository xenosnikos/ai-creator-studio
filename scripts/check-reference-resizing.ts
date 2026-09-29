import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

// Never load app settings or storage against a developer's database.
const testDir = fs.mkdtempSync(path.join(process.cwd(), ".reference-test-"));
process.env.DATA_DIR = testDir;
for (const kind of ["IMAGE", "VIDEO", "VOICE", "LIPSYNC", "LLM"]) {
  process.env[`${kind}_PROVIDER`] = "mock";
}
globalThis.fetch = async () => { throw new Error("Network forbidden in reference tests"); };

test("reference uploads", async (t) => {
  try {
    const { imageProvider } = await import("@/lib/providers/registry");
    const { providerReadyContextReferences, referenceReady, persistReference,
      providerReadyStoredReference, providerReadyCreatorReferences } = await import("@/lib/creators/references");
    const provider = imageProvider();
    const uploads: { bytes: Buffer; name: string; mime: string }[] = [];
    provider.uploadImage = async (bytes, name, mime) => {
      uploads.push({ bytes, name, mime });
      return `https://example.test/reference-${uploads.length}`;
    };

    await t.test("oversized context PNG is uploaded as a 2048px JPEG with matching extension/MIME", async () => {
      const bytes = await sharp({ create: { width: 4096, height: 1024, channels: 3, background: "#cc6633" } }).png().toBuffer();
      await providerReadyContextReferences([`data:image/png;base64,${bytes.toString("base64")}`], "large");
      const uploaded = uploads.at(-1)!;
      const metadata = await sharp(uploaded.bytes).metadata();
      assert.equal(metadata.width, 2048);
      assert.equal(metadata.height, 512);
      assert.equal(metadata.format, "jpeg");
      assert.equal(uploaded.mime, "image/jpeg");
      assert.match(uploaded.name, /\.jpg$/);
    });

    await t.test("small PNG, JPEG, WebP and GIF retain exact bytes and MIME", async () => {
      for (const format of ["png", "jpeg", "webp", "gif"] as const) {
        const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
          .toFormat(format).toBuffer();
        const mime = `image/${format}`;
        const ready = await referenceReady(bytes, mime);
        assert.strictEqual(ready.bytes, bytes);
        assert.equal(ready.mimeType, mime);
        await providerReadyContextReferences([`data:${mime};base64,${bytes.toString("base64")}`], "small");
        assert.deepEqual(uploads.at(-1)!.bytes, bytes);
        assert.equal(uploads.at(-1)!.mime, mime);
        assert.match(uploads.at(-1)!.name, new RegExp(`\\.${format === "jpeg" ? "jpg" : format}$`));
      }
    });

    await t.test("2048px boundary passes through, byte limit triggers conversion without enlargement", async () => {
      const bytes = await sharp({ create: { width: 2048, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
      assert.strictEqual((await referenceReady(bytes, "image/png")).bytes, bytes);
      // Legal decodable PNG with deterministic trailing padding isolates byte-size behavior.
      const padded = Buffer.concat([bytes, Buffer.alloc(8 * 1024 * 1024 + 1 - bytes.length)]);
      const ready = await referenceReady(padded, "image/png");
      const metadata = await sharp(ready.bytes).metadata();
      assert.equal(metadata.width, 2048);
      assert.equal(metadata.height, 8);
      assert.equal(ready.mimeType, "image/jpeg");
      assert.ok(ready.bytes.length < padded.length);
    });

    await t.test("resizing applies EXIF orientation and removes orientation metadata", async () => {
      const bytes = await sharp({ create: { width: 3072, height: 1536, channels: 3, background: "red" } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer();
      const ready = await referenceReady(bytes, "image/jpeg");
      const metadata = await sharp(ready.bytes).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, 2048);
      assert.equal(metadata.orientation, undefined);
      assert.equal(ready.mimeType, "image/jpeg");
    });

    await t.test("oversized transparent PNG is flattened onto white", async () => {
      const bytes = await sharp({ create: { width: 3072, height: 96, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
      const ready = await referenceReady(bytes, "image/png");
      const { data, info } = await sharp(ready.bytes).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 3);
      assert.equal(info.width, 2048);
      assert.ok(data.every((channel) => channel >= 254));
      assert.equal(ready.mimeType, "image/jpeg");
    });

    await t.test("SVG mock placeholders pass through even when oversized", async () => {
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096"><rect width="4096" height="4096" fill="red"/></svg>');
      const ready = await referenceReady(bytes, "image/svg+xml");
      assert.strictEqual(ready.bytes, bytes);
      assert.equal(ready.mimeType, "image/svg+xml");
      await providerReadyContextReferences([`data:image/svg+xml;base64,${bytes.toString("base64")}`], "svg");
      assert.deepEqual(uploads.at(-1)!.bytes, bytes);
      assert.equal(uploads.at(-1)!.mime, "image/svg+xml");
      // Existing context extension fallback is intentionally not changed by this port.
      assert.match(uploads.at(-1)!.name, /\.jpg$/);
    });

    await t.test("invalid input and mismatched MIME are not validated (known best-effort limitation)", async () => {
      const invalid = Buffer.from("not an image");
      const result = await referenceReady(invalid, "image/png");
      assert.strictEqual(result.bytes, invalid);
      assert.equal(result.mimeType, "image/png");
      await providerReadyContextReferences([`data:image/png;base64,${invalid.toString("base64")}`], "invalid");
      assert.deepEqual(uploads.at(-1)!.bytes, invalid);
      assert.equal(uploads.at(-1)!.mime, "image/png");
      const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
      const mismatched = await referenceReady(small, "image/jpeg");
      assert.strictEqual(mismatched.bytes, small);
      assert.equal(mismatched.mimeType, "image/jpeg");
    });

    const { creators } = await import("@/lib/repo");
    const { DEFAULT_VOICE } = await import("@/lib/types");
    const { readAsset } = await import("@/lib/storage");
    const creator = creators.create({ name: "Reference Test", category: "Test", persona: "Direct",
      identity: { canonical: "Adult presenter", face: "Oval", hair: "Black", skinTone: "Brown",
        bodyType: "Average", distinguishingFeatures: "", wardrobe: "Shirt", negative: "" },
      voice: DEFAULT_VOICE, status: "ready" });
    const original = await sharp({ create: { width: 3072, height: 768, channels: 3, background: "green" } }).png().toBuffer();
    const reference = await persistReference({ creatorId: creator.id, source: `data:image/png;base64,${original.toString("base64")}`,
      kind: "seed", isAnchor: true });

    async function assertLastResized() {
      const uploaded = uploads.at(-1)!;
      const metadata = await sharp(uploaded.bytes).metadata();
      assert.equal(metadata.width, 2048);
      assert.equal(metadata.height, 512);
      assert.equal(metadata.format, "jpeg");
      assert.equal(uploaded.mime, "image/jpeg");
      assert.match(uploaded.name, /\.jpg$/);
      assert.deepEqual(await readAsset(reference.localPath!), original);
    }
    await t.test("intake uploads resized bytes but preserves original on disk", assertLastResized);
    await t.test("stored reference rehosting resizes without altering original and caches upload", async () => {
      await providerReadyStoredReference(reference.localPath!, "stored");
      await assertLastResized();
      const count = uploads.length;
      await providerReadyStoredReference(reference.localPath!, "stored");
      assert.equal(uploads.length, count);
    });
    await t.test("legacy mock-name creator bypass remains unchanged", async () => {
      const refs = [{ ...reference, localPath: null }];
      const count = uploads.length;
      const originalName = provider.name;
      Object.defineProperty(provider, "name", { value: "mock", configurable: true });
      try {
        assert.strictEqual(await providerReadyCreatorReferences(refs), refs);
        assert.equal(uploads.length, count);
      } finally {
        Object.defineProperty(provider, "name", { value: originalName, configurable: true });
      }
    });
    await t.test("creator refresh resizes using offline upload spy and keeps cached remote URL", async () => {
      // Exercise the non-mock branch without selecting or contacting a live provider.
      const originalName = provider.name;
      Object.defineProperty(provider, "name", { value: "offline-reference-test", configurable: true });
      try {
        const result = await providerReadyCreatorReferences([reference]);
        await assertLastResized();
        assert.equal(creators.references(creator.id)[0].remoteUrl, result[0].remoteUrl);
        const count = uploads.length;
        const cached = await providerReadyCreatorReferences([reference]);
        assert.deepEqual(cached, result);
        assert.equal(uploads.length, count);
      } finally {
        Object.defineProperty(provider, "name", { value: originalName, configurable: true });
      }
    });
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
