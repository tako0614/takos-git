/**
 * Background work lifecycle — the ONE way this worker starts work whose result
 * the client does not wait for (webhook delivery, audit fan-out, …).
 *
 * ## Why this exists
 *
 * On Cloudflare, everything still running when the `fetch` handler's Response is
 * returned is CANCELLED unless it was handed to `ExecutionContext.waitUntil`.
 * The issue-webhook path used to be `void Promise.resolve(sink(event)).catch()`
 * from a worker whose `fetch(request, env)` signature never even accepted a
 * `ctx` — so every issue webhook was deterministically dropped mid-flight with
 * no error anywhere. The defect was invisible because nothing in the type system
 * said "this promise needs an owner".
 *
 * ## The invariant this makes structural
 *
 * Background work can only be started through a {@link BackgroundScope} value,
 * and a scope can only be built two ways:
 *
 *  - {@link deferredScope} — has a real `ExecutionContext`; work is handed to
 *    `waitUntil` and outlives the Response.
 *  - {@link inlineScope} — has NO `ExecutionContext` (embedders that call
 *    `fetch(request, env)` with two arguments, tests, local dev); work is
 *    awaited via {@link BackgroundScope.settled} BEFORE the Response is handed
 *    back, so it is slower but never lost.
 *
 * There is deliberately no third "drop it" constructor and no `ctx | undefined`
 * anywhere in the API: the absence of an `ExecutionContext` can only make
 * delivery synchronous, never silent. That is the property the old code lacked.
 *
 * Rejections are caught in exactly one place — {@link BackgroundScope.run} —
 * so a failing background task can never disturb the mutation that already
 * committed, and can never become an unhandled rejection either.
 */

/** The `ExecutionContext` subset a deferred scope needs. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Where background failures are reported. Defaults to `console.error`. */
export type BackgroundLog = (
  label: string,
  error: unknown,
) => void;

export interface BackgroundScope {
  /**
   * Start background work. Never throws and never returns the promise: the
   * caller cannot accidentally re-own (or ignore) a rejection. `label` is what
   * shows up in the log when the task fails.
   */
  run(label: string, task: () => Promise<unknown> | unknown): void;

  /**
   * Resolve once work started on this scope can no longer be lost. For a
   * deferred scope this is immediate (`waitUntil` owns it); for an inline scope
   * it awaits every task started so far, including ones started by earlier
   * tasks. The request entrypoint awaits this before returning the Response.
   */
  settled(): Promise<void>;
}

function defaultLog(label: string, error: unknown): void {
  console.error(`[background] ${label} failed`, error);
}

/** Run the task, funnelling any sync throw or async rejection into `log`. */
function guarded(
  label: string,
  task: () => Promise<unknown> | unknown,
  log: BackgroundLog,
): Promise<void> {
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(task());
  } catch (error) {
    log(label, error);
    return Promise.resolve();
  }
  return started.then(
    () => undefined,
    (error: unknown) => {
      log(label, error);
    },
  );
}

/**
 * A scope backed by a real `ExecutionContext`: work outlives the Response.
 * `ctx` is REQUIRED — callers that may not have one use {@link inlineScope}.
 */
export function deferredScope(
  ctx: WaitUntilContext,
  log: BackgroundLog = defaultLog,
): BackgroundScope {
  return {
    run(label, task) {
      ctx.waitUntil(guarded(label, task, log));
    },
    settled() {
      // waitUntil already owns the work; the Response need not wait for it.
      return Promise.resolve();
    },
  };
}

/**
 * A scope with no `ExecutionContext`: work is awaited by {@link
 * BackgroundScope.settled} before the Response is returned. Correct-but-slower
 * rather than fast-but-lost.
 */
export function inlineScope(log: BackgroundLog = defaultLog): BackgroundScope {
  const pending = new Set<Promise<void>>();
  return {
    run(label, task) {
      const promise = guarded(label, task, log).finally(() => {
        pending.delete(promise);
      });
      pending.add(promise);
    },
    async settled() {
      // A task may start further tasks; drain until the set stays empty.
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/**
 * Build the scope for one request: deferred when the runtime handed us an
 * `ExecutionContext`, inline otherwise. This is the only place the two
 * constructors are chosen between.
 */
export function requestScope(
  ctx: WaitUntilContext | undefined,
  log: BackgroundLog = defaultLog,
): BackgroundScope {
  return ctx ? deferredScope(ctx, log) : inlineScope(log);
}
