import sharp from "sharp";

import { fail, route } from "@/lib/api";
import { mimeForPath, readAsset } from "@/lib/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ path: string[] }> };

/**
 * Widths a caller may ask for, so a URL cannot make the server resize to
 * anything it likes. Enough steps for a thumbnail, a card and a preview.
 */
const ALLOWED_WIDTHS = [160, 320, 640, 1080];

/**
 * Serve locally mirrored assets, optionally resized.
 *
 * Provider URLs expire, so every generated asset is proxied from disk. Path
 * traversal is blocked in `readAsset`.
 *
 * The `w` parameter is not a nicety. Keyframes and identity sheets are
 * rendered at 4K because detail on a face is the whole game — which makes a
 * single creator's three reference images around 57 MB of PNG. Those same
 * files were being sent to the browser as page thumbnails at full size, so
 * opening the creator list downloaded a hundred megabytes to draw pictures a
 * few hundred pixels wide. On a laptop that is merely wasteful; over a shared
 * link it is the difference between a page that loads and one that appears to
 * hang, which is exactly how it was reported.
 *
 * Resized copies are cached next to the original, so the cost is paid once.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  const { path } = await params;
  const relativePath = path.map(decodeURIComponent).join("/");

  const requested = Number(new URL(request.url).searchParams.get("w"));
  const width = ALLOWED_WIDTHS.includes(requested) ? requested : null;

  try {
    const bytes = await readAsset(relativePath);

    if (width && /\.(png|jpe?g|webp)$/i.test(relativePath)) {
      try {
        // WebP for the resized copy: a 4K PNG of a face is megabytes even
        // scaled down, and nothing about a thumbnail needs lossless.
        const resized = await sharp(bytes)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        return new Response(new Uint8Array(resized), {
          status: 200,
          headers: {
            "Content-Type": "image/webp",
            "Content-Length": String(resized.length),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        // Resizing is an optimisation. A codec sharp cannot read should still
        // serve the original rather than 500.
      }
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mimeForPath(relativePath),
        "Content-Length": String(bytes.length),
        // Assets are immutable once written — filenames carry a timestamp.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return fail("Asset not found", 404);
  }
});
