import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { ProviderError } from "@/lib/providers/types";

/** Consistent JSON error shape so the client can render failures uniformly. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, detail?: unknown): NextResponse {
  return NextResponse.json({ error: message, detail }, { status });
}

/**
 * Wrap a route handler so thrown errors become clean HTTP responses instead of
 * opaque 500s. Provider errors carry a user-actionable message (e.g. "set your
 * API key"), so they are surfaced verbatim.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof BadRequest) {
        return fail(error.message, error.status);
      }
      if (error instanceof ZodError) {
        return fail("Invalid request body", 422, error.flatten());
      }
      if (error instanceof ProviderError) {
        return fail(error.message, 502, { provider: error.provider });
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[api]", message);
      return fail(message, 500);
    }
  };
}

/**
 * The caller sent something wrong, and it is not the server's fault.
 *
 * Without this every such error fell through to the catch-all and came back as
 * a 500 — so a truncated request body, which is a client problem with an
 * obvious fix, was reported as the server having broken. Anything monitoring
 * 5xx would have counted it, and the message telling the caller what to do was
 * buried under a status code that said not to bother trying again.
 */
export class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BadRequest";
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BadRequest("Request body must be valid JSON");
  }
}
