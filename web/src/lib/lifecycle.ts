/**
 * Component-scoped lifecycle primitives for timers and listeners.
 *
 * ## Why
 *
 * Every hand-rolled poller in this SPA was the same five lines: a `let timer`,
 * a `setInterval`, an `onCleanup`, and a liveness flag. `LogViewer` got it
 * wrong in the one way the shape invites — it read the reactive `props.live`
 * ONCE inside `onMount`, so a finished job kept polling `…/jobs/:id/logs` (R2 +
 * D1 backed) every 4s for as long as the page stayed open. Nothing in the code
 * said "this must react to liveness"; the correct version (`JobCard`) and the
 * broken one looked equally reasonable.
 *
 * {@link createPolling} removes the choice: liveness is an ACCESSOR the effect
 * subscribes to, and there is no timer handle to hold, forget, or leak — the
 * interval exists exactly while `active()` is true and the owning component is
 * mounted. {@link createLifecycleOwner} does the same for one-shot timers and
 * event listeners: it hands back no handle, only a disposal that Solid runs.
 */

import { createEffect, onCleanup, getOwner } from "solid-js";

export interface PollingOptions {
  /**
   * Reactive predicate: polling runs exactly while this is true. It is an
   * accessor, not a boolean, so a non-reactive read (the LogViewer bug) cannot
   * be written.
   */
  readonly active: () => boolean;
  readonly intervalMs: number;
  /** One poll. Overlapping ticks are skipped while a previous one is in flight. */
  readonly tick: () => void | Promise<unknown>;
}

export interface ReactiveListenerOptions<T extends EventTarget> {
  /** Reactive predicate controlling whether the listener is attached. */
  readonly active: () => boolean;
  readonly target: T;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject;
  readonly options?: AddEventListenerOptions;
}

/**
 * Poll while `active()` is true. Stops on the tick after it turns false and on
 * component cleanup; restarts if it turns true again.
 */
export function createPolling(options: PollingOptions): void {
  createEffect(() => {
    if (!options.active()) return;
    let inFlight = false;
    let stopped = false;
    const timer = setInterval(() => {
      // A slow poll must not stack requests behind itself.
      if (inFlight || stopped) return;
      inFlight = true;
      void Promise.resolve(options.tick()).finally(() => {
        inFlight = false;
      });
    }, options.intervalMs);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });
}

/**
 * Attach one event listener exactly while `active()` is true.
 *
 * Solid disposes the previous effect run before re-running it, so toggling the
 * predicate cannot accumulate duplicate document/window listeners.
 */
export function createReactiveListener<T extends EventTarget>(
  options: ReactiveListenerOptions<T>,
): void {
  createEffect(() => {
    if (!options.active()) return;
    options.target.addEventListener(
      options.type,
      options.handler,
      options.options,
    );
    onCleanup(() => {
      options.target.removeEventListener(
        options.type,
        options.handler,
        options.options,
      );
    });
  });
}

export interface LifecycleOwner {
  /** Run `task` once after `ms`. Cancelled on dispose; returns no handle. */
  timeout(ms: number, task: () => void): void;
  /** Add an event listener removed on dispose; returns no handle. */
  listen<T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void;
  /** Register an arbitrary teardown (object URLs, observers, sockets). */
  own(teardown: () => void): void;
  /** Release everything now. Idempotent; also runs on component cleanup. */
  dispose(): void;
}

/**
 * Create an owner bound to the calling component (when there is one, which is
 * the normal case) so cleanup cannot be forgotten.
 */
export function createLifecycleOwner(): LifecycleOwner {
  const teardowns = new Set<() => void>();
  let disposed = false;

  const add = (teardown: () => void): void => {
    if (disposed) {
      teardown();
      return;
    }
    teardowns.add(teardown);
  };

  const owner: LifecycleOwner = {
    timeout(ms, task) {
      const handle = setTimeout(() => {
        teardowns.delete(cancel);
        task();
      }, ms);
      const cancel = () => clearTimeout(handle);
      add(cancel);
    },
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      add(() => target.removeEventListener(type, handler, options));
    },
    own(teardown) {
      add(teardown);
    },
    dispose() {
      disposed = true;
      for (const teardown of teardowns) teardown();
      teardowns.clear();
    },
  };

  if (getOwner()) onCleanup(() => owner.dispose());
  return owner;
}
