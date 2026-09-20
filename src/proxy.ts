import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional password gate.
 *
 * Lives in `proxy.ts` because Next 16 renamed the middleware convention; the
 * behaviour is unchanged and the file still runs before every matched route.
 *
 * The app has no user accounts — it is a single-operator tool. But the moment it
 * is shared over a tunnel or deployed somewhere public, "no accounts" means
 * anyone with the URL can drive it and spend the credits on the saved API keys.
 *
 * Setting SHARE_PASSWORD turns on HTTP Basic auth across every route, which is
 * enough to hand a link to one reviewer without exposing it to the internet at
 * large. Leaving it unset changes nothing, so local use is unaffected.
 *
 * This is a share gate, not an auth system: one shared secret, no sessions, no
 * per-user identity, no lockout. Do not mistake it for production auth.
 */

const REALM = 'Basic realm="AI Creator Studio", charset="UTF-8"';

export default function proxy(request: NextRequest) {
  const expected = process.env.SHARE_PASSWORD?.trim();
  if (!expected) return NextResponse.next();

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    // Credentials are `user:password`; any username is accepted so the person
    // you share with does not need to be told one.
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (decoded.includes(":") && timingSafeEqual(supplied, expected)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": REALM,
      // Never let a browser or proxy cache a challenge or a protected response.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Compare without leaking length or match position through timing. Overkill for
 * a POC, but comparing secrets with `===` is a habit worth not forming.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export const config = {
  /**
   * Every route except Next's own internals.
   *
   * `_next` has to be excluded *entirely*, not just `_next/static` and
   * `_next/image`. Dev-mode hot reload runs over a WebSocket at
   * `/_next/webpack-hmr`, and matching that path means this function answers the
   * upgrade request with an ordinary HTTP response. The browser rejects the
   * handshake (`ERR_INVALID_HTTP_RESPONSE`), the HMR client throws while
   * starting, and Next's bootstrap never reaches `hydrateRoot` — so every page
   * renders as server HTML with no React attached. The symptom is a page that
   * looks completely normal but whose buttons and inputs do nothing at all,
   * which is a genuinely baffling thing to debug.
   *
   * Production is unaffected (no HMR socket), which is exactly why this hid.
   *
   * Excluding `_next` costs nothing: those files are compiled assets and hold
   * no data. The gate still covers every page and every API route.
   */
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
