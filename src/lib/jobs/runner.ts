import { config } from "@/lib/config";
import { cancellation, jobs } from "@/lib/repo";
import type { Job } from "@/lib/types";
import type { TaskHandle, TaskResult } from "@/lib/providers/types";

import { handlers } from "@/lib/jobs/handlers";
import { settleProjectStatus } from "@/lib/jobs/project-status";

/**
 * A small in-process job runner.
 *
 * Everything the platform does that is slow — storyboarding, identity sheets,
 * image renders, voice, video — goes through here, so the UI never blocks on a
 * provider and a failed step is retryable in isolation.
 *
 * Scope note: this is a POC-grade queue (single process, SQLite-backed, no
 * cross-instance locking). It was chosen because it needs zero infrastructure
 * to run. The `JobHandler` contract is what a production system would keep;
 * swapping in BullMQ/Temporal means reimplementing this file only.
 */

const MAX_CONCURRENT = 3;

let running = 0;
let ticking = false;
let started = false;

export interface JobContext {
  job: Job;
  /** Report progress back to the DB so the UI can show it. */
  setProgress(progress: number): void;
  /** Poll a provider task to completion, surfacing progress along the way. */
  awaitTask(
    handle: TaskHandle,
    poll: (handle: TaskHandle) => Promise<TaskResult>,
    options?: AwaitOptions,
  ): Promise<TaskResult>;
}

export interface AwaitOptions {
  progressFloor?: number;
  progressCeiling?: number;
  /**
   * How to submit the task again. Providers fail a fraction of tasks for
   * reasons that have nothing to do with the request — "the server is busy",
   * "internal error, please try again later" — and charge nothing for them.
   * Supplying this turns those into a retry instead of a dead job.
   */
  resubmit?: () => Promise<TaskHandle>;
}

export type JobHandler = (context: JobContext) => Promise<Record<string, unknown>>;

/**
 * Resubmits after a provider-side failure that says nothing about the request.
 *
 * Five attempts rather than three because lip sync in particular returns "the
 * server is busy" often — it needed three tries to succeed once and more than
 * three on another run. These failures cost no credits, so the only price of a
 * higher ceiling is waiting; the price of too low a ceiling is discarding a
 * clip that was already paid for.
 */
const MAX_RESUBMITS = 4;

/** Kick the queue. Safe to call from anywhere, including request handlers. */
export function scheduleTick(): void {
  if (ticking) return;
  ticking = true;
  // Defer so the HTTP response that enqueued the job is not delayed.
  setTimeout(() => {
    ticking = false;
    void tick();
  }, 0);
}

/**
 * Called once from instrumentation on server boot: re-queue anything that was
 * mid-flight when the process died, then start draining.
 */
export function startRunner(): void {
  if (started) return;
  started = true;
  const requeued = jobs.requeueStale();
  if (requeued > 0) {
    console.info(`[jobs] re-queued ${requeued} job(s) orphaned by a restart`);
  }
  setInterval(() => scheduleTick(), 5000).unref?.();
  scheduleTick();
}

async function tick(): Promise<void> {
  while (running < MAX_CONCURRENT) {
    // The local counter is the cheap gate; the real one is in the claim, which
    // counts running rows in the shared table. See jobs.claimNext.
    const job = jobs.claimNext(MAX_CONCURRENT);
    if (!job) return;
    running += 1;
    void run(job).finally(() => {
      running -= 1;
      scheduleTick();
    });
  }
}

/** Thrown to unwind a handler whose job was cancelled mid-poll. */
export class JobCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "JobCancelled";
  }
}

async function run(job: Job): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) {
    jobs.fail(job.id, `No handler registered for job type "${job.type}"`);
    return;
  }

  const context: JobContext = {
    job,
    setProgress(progress) {
      jobs.setProgress(job.id, progress);
    },
    awaitTask: (handle, poll, options) => awaitTask(job, handle, poll, options),
  };

  try {
    const result = await handler(context);
    // Cancelled while the handler was mid-flight: keep the cancellation rather
    // than overwriting it with a success the user has already said they do not
    // want. The provider work is done and paid for either way.
    if (cancellation.isCancelled(job.id)) return;
    jobs.succeed(job.id, result);
  } catch (error) {
    if (error instanceof JobCancelled || cancellation.isCancelled(job.id)) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jobs] ${job.type} ${job.id} failed:`, message);
    jobs.fail(job.id, message);
  } finally {
    // After the job row is terminal, never before — the status is derived from
    // what is still in flight, and this job is only not-in-flight once the
    // succeed/fail above has landed. In `finally` so a cancelled job, which
    // returns early from both branches, still settles the project.
    settleProjectStatus(job.projectId);
  }
}

/**
 * Poll a provider task until it reaches a terminal state.
 * Progress is mapped into a sub-range so a multi-step job (image then video)
 * shows a single monotonic bar rather than resetting to zero at each step.
 */
async function awaitTask(
  job: Job,
  initialHandle: TaskHandle,
  poll: (handle: TaskHandle) => Promise<TaskResult>,
  options?: AwaitOptions,
): Promise<TaskResult> {
  const floor = options?.progressFloor ?? 0;
  const ceiling = options?.progressCeiling ?? 100;
  const deadline = Date.now() + config.jobs.timeoutMs;
  let consecutiveErrors = 0;
  let handle = initialHandle;
  let resubmits = 0;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `Provider task ${handle.taskId} did not finish within ${Math.round(
          config.jobs.timeoutMs / 1000,
        )}s`,
      );
    }

    let result: TaskResult;
    try {
      result = await poll(handle);
      consecutiveErrors = 0;
    } catch (error) {
      // A transient poll failure should not kill a job that may still succeed.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw error;
      await sleep(config.jobs.pollIntervalMs);
      continue;
    }

    // Checked on every poll, which is the only place a long render can notice
    // it has been cancelled — handlers are otherwise uninterruptible.
    if (cancellation.isCancelled(job.id)) throw new JobCancelled();

    jobs.setProgress(job.id, floor + ((ceiling - floor) * result.progress) / 100);

    if (result.status === "succeeded") return result;
    if (result.status === "failed") {
      const canRetry = result.retryable && options?.resubmit && resubmits < MAX_RESUBMITS;
      if (!canRetry) throw new Error(result.error ?? "Provider reported failure");
      resubmits += 1;
      console.info(
        `[jobs] ${job.type} ${job.id}: provider failed transiently (${result.error}); ` +
          `resubmitting (${resubmits}/${MAX_RESUBMITS})`,
      );
      // Back off before resubmitting — "the server is busy" is worth waiting on.
      await sleep(5000 * resubmits);
      handle = await options!.resubmit!();
      continue;
    }
    await sleep(config.jobs.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
