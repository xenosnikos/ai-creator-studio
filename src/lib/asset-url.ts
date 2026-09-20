/**
 * Ask the asset route for a copy no wider than the box it will be drawn in.
 *
 * Generated stills are rendered at 4K because detail on a face is the whole
 * point of the identity system. A thumbnail does not need any of it, and
 * sending the original meant a page of them downloaded tens of megabytes to
 * draw pictures a few hundred pixels wide — one creator's three references come
 * to about 57 MB. On a laptop that is wasteful; over a shared link it reads as
 * the page hanging.
 *
 * Deliberately free of a "use client" directive so both server pages and client
 * components can use it. Anything that is not one of our own asset URLs is
 * returned untouched — a provider URL has no resizing endpoint.
 */
export type AssetWidth = 160 | 320 | 640 | 1080;

export function sized(url: string | null | undefined, width: AssetWidth): string {
  if (!url) return "";
  if (!url.startsWith("/api/assets/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}
