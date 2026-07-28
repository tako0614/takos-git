/**
 * Test-only doubles that make the Worker's real background-work lifecycle
 * observable. Imported ONLY by `*.test.ts` (same rule as `test-bucket.ts` and
 * `features/repos/testkit.ts`), so it never reaches the deployed bundle.
 *
 * ## Why a strict double instead of a plain spy
 *
 * A plain `{ waitUntil: () => {} }` stub is exactly the mock that let the issue
 * webhook defect ship: it makes a dropped promise indistinguishable from a
 * delivered one, because in-process a floating promise still runs to completion.
 * {@link strictExecutionContext} reproduces the constraint that is real at
 * runtime instead: once the Response is returned, everything that was NOT
 * handed to `waitUntil` is cancelled, and touching a binding from cancelled work
 * fails. Guarded bindings (see {@link StrictExecutionContext.guard}) throw
 * `BindingAfterResponseError` in that window, so "the delivery was dropped"
 * becomes a test failure rather than a silent pass.
 */

/** Thrown when cancelled (post-Response, unregistered) work touches a binding. */
export class BindingAfterResponseError extends Error {
  constructor(readonly member: string) {
    super(
      `binding member ${member} was used after the Response returned; the work ` +
        `was not registered with ExecutionContext.waitUntil and would have been ` +
        `cancelled on Cloudflare`,
    );
    this.name = "BindingAfterResponseError";
  }
}

export interface StrictExecutionContext {
  /** The `ExecutionContext` surface handed to `worker.fetch`. */
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Call the moment the Response is returned to the client. */
  endInvocation(): void;
  /**
   * Await the work that WAS registered with `waitUntil`, then close the
   * invocation for good: any later binding access throws.
   */
  drain(): Promise<void>;
  /** Wrap a binding (D1, R2, a sink's deps) so post-cancellation use throws. */
  guard<T extends object>(binding: T): T;
  /** How many promises were handed to `waitUntil`. */
  readonly registered: number;
}

export function strictExecutionContext(): StrictExecutionContext {
  const pending: Promise<unknown>[] = [];
  let registeredCount = 0;
  let responded = false;
  let closed = false;

  function assertUsable(member: string): void {
    // Between endInvocation() and drain() the registered work is still running,
    // so bindings stay usable — that is precisely what waitUntil buys. Only
    // unregistered work reaches the closed state and fails.
    if (closed) throw new BindingAfterResponseError(member);
  }

  const ctx: StrictExecutionContext = {
    waitUntil(promise) {
      if (responded) {
        throw new Error(
          "waitUntil called after the Response returned; the runtime rejects this",
        );
      }
      pending.push(promise);
      registeredCount += 1;
    },
    passThroughOnException() {},
    endInvocation() {
      responded = true;
      // Nothing was registered, so nothing survives the Response.
      if (pending.length === 0) closed = true;
    },
    async drain() {
      responded = true;
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.allSettled(batch);
      }
      closed = true;
    },
    guard<T extends object>(binding: T): T {
      return new Proxy(binding, {
        get(target, property, receiver) {
          assertUsable(String(property));
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value === "function") {
            return (...args: unknown[]) => {
              assertUsable(String(property));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });
    },
    get registered() {
      return registeredCount;
    },
  };
  return ctx;
}

/** Collect background failures instead of printing them. */
export function recordingLog(): {
  log: (label: string, error: unknown) => void;
  entries: { label: string; error: unknown }[];
} {
  const entries: { label: string; error: unknown }[] = [];
  return { log: (label, error) => void entries.push({ label, error }), entries };
}
