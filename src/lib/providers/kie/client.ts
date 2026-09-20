import { config } from "@/lib/config";
import { ProviderError, type TaskResult } from "@/lib/providers/types";
import { secrets } from "@/lib/settings";

/**
 * Thin transport for the KIE AI unified job API.
 *
 * Every KIE-hosted model uses the same three
 * calls, which is why one client serves all three media adapters:
 *
 *   POST /api/v1/jobs/createTask   -> { data: { taskId } }
 *   GET  /api/v1/jobs/recordInfo   -> { data: { state, progress, resultJson } }
 *   POST /api/file-base64-upload   -> { data: { downloadUrl } }
 */

interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

interface KieCreateTaskData {
  taskId: string;
  recordId?: string;
}

interface KieRecordInfoData {
  taskId: string;
  model: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail";
  param?: string;
  resultJson?: string;
  failCode?: string;
  failMsg?: string;
  progress?: number;
  creditsConsumed?: number;
}

interface KieUploadData {
  fileName: string;
  filePath: string;
  downloadUrl: string;
  fileSize: number;
  mimeType: string;
}

function apiKey(): string {
  const key = secrets().kieApiKey;
  if (!key) {
    throw new ProviderError(
      "No KIE API key configured. Add one on the Settings page, or set KIE_API_KEY in .env.local. To run without keys, switch the image/video/voice providers to Mock.",
      "kie",
    );
  }
  return key;
}

/**
 * Is this worth trying again?
 *
 * Observed against a live account: gateway 5xx, "DNS resolution failure" served
 * as an HTML error page, and envelope messages like "The server is busy" or
 * "internal error, please try again later". None of these say anything about
 * the request — they are the provider having a moment — and none of them
 * consume credits. A 4xx, by contrast, means the request itself is wrong and
 * will be wrong every time.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return true; // Network-level failure.
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return false;
  return true;
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await requestOnce<T>(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

async function requestOnce<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ProviderError(`Network error calling KIE (${url})`, "kie", undefined, cause);
  }

  const text = await response.text();
  let body: KieEnvelope<T>;
  try {
    body = JSON.parse(text) as KieEnvelope<T>;
  } catch {
    throw new ProviderError(
      `KIE returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`,
      "kie",
      response.status,
    );
  }

  // KIE signals failure through the envelope `code`, not only the HTTP status.
  if (!response.ok || body.code !== 200) {
    throw new ProviderError(
      `KIE error ${body.code ?? response.status}: ${body.msg ?? "unknown error"}`,
      "kie",
      body.code ?? response.status,
      body,
    );
  }
  return body.data;
}

/** Submit a generation task. Returns the provider task id. */
export async function createTask(
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  const data = await request<KieCreateTaskData>(`${config.kie.baseUrl}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!data?.taskId) {
    throw new ProviderError("KIE createTask returned no taskId", "kie", undefined, data);
  }
  return data.taskId;
}

/** Poll a task and normalise it into the provider-agnostic TaskResult shape. */
export async function pollTask(taskId: string): Promise<TaskResult> {
  const data = await request<KieRecordInfoData>(
    `${config.kie.baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { method: "GET" },
  );

  const progress = normaliseProgress(data.progress, data.state);

  if (data.state === "fail") {
    const message = data.failMsg || data.failCode || "Generation failed";
    return {
      status: "failed",
      progress,
      urls: [],
      error: message,
      // Some failures are the provider being busy rather than the job being
      // bad, and cost no credits. Flagged so the caller can resubmit instead of
      // surfacing a dead end to the user.
      retryable: /server is busy|internal error|try again later|timeout|timed out/i.test(message),
      raw: data,
    };
  }

  if (data.state !== "success") {
    return { status: "pending", progress, urls: [], raw: data };
  }

  const urls = extractResultUrls(data.resultJson);
  if (urls.length === 0) {
    return {
      status: "failed",
      progress: 100,
      urls: [],
      error: "KIE reported success but returned no result URLs",
      raw: data,
    };
  }
  return { status: "succeeded", progress: 100, urls, raw: data };
}

/**
 * KIE reports progress inconsistently across models (sometimes 0-100,
 * sometimes 0-1, sometimes absent). Normalise to a monotonic 0-100.
 */
function normaliseProgress(
  progress: number | undefined,
  state: KieRecordInfoData["state"],
): number {
  if (state === "success") return 100;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    const scaled = progress > 0 && progress <= 1 ? progress * 100 : progress;
    return Math.max(0, Math.min(99, Math.round(scaled)));
  }
  // Fall back to coarse stage-based progress so the UI still moves.
  switch (state) {
    case "waiting":
      return 5;
    case "queuing":
      return 15;
    case "generating":
      return 50;
    default:
      return 0;
  }
}

/** `resultJson` is a JSON *string*; result URLs live under a few known keys. */
function extractResultUrls(resultJson: string | undefined): string[] {
  if (!resultJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const record = parsed as Record<string, unknown>;
  const candidates = [
    record.resultUrls,
    (record.resultObject as Record<string, unknown> | undefined)?.resultUrls,
    (record.resultObject as Record<string, unknown> | undefined)?.audio_urls,
    (record.resultObject as Record<string, unknown> | undefined)?.video_urls,
    (record.resultObject as Record<string, unknown> | undefined)?.image_urls,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const urls = candidate.filter((u): u is string => typeof u === "string" && u.length > 0);
      if (urls.length > 0) return urls;
    }
  }

  // Some models return a bare string URL.
  for (const key of ["resultUrl", "url", "audioUrl", "videoUrl"]) {
    const value = record[key];
    if (typeof value === "string" && value.startsWith("http")) return [value];
  }
  return [];
}

/**
 * Upload bytes so a generation model can fetch them by URL. KIE stores these
 * temporarily (~3 days), which is fine: we also mirror every reference locally
 * and re-upload on expiry.
 */
export async function uploadBase64(
  bytes: Buffer,
  fileName: string,
  uploadPath = "images/creator-refs",
): Promise<string> {
  const data = await request<KieUploadData>(
    `${config.kie.uploadBaseUrl}/api/file-base64-upload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base64Data: bytes.toString("base64"),
        uploadPath,
        fileName,
      }),
    },
  );
  if (!data?.downloadUrl) {
    throw new ProviderError("KIE upload returned no downloadUrl", "kie", undefined, data);
  }
  return data.downloadUrl;
}

/**
 * Clamp a value to a provider's documented input ceiling.
 *
 * Shared because all four KIE adapters need it and had grown identical private
 * copies. The ellipsis matters: a silently cut prompt and a deliberately
 * shortened one look the same in a log otherwise.
 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
