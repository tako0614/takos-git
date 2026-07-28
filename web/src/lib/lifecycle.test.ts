/**
 * First test in `web/src`. It exists because the polling bug it pins was
 * invisible to every other kind of check: `LogViewer` read its reactive
 * `live` prop once, so the interval outlived the job it was following, and
 * nothing typechecked or reviewed differently than the correct version.
 *
 * Run with the repo suite (`bun test`); Solid's reactivity works outside a DOM.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";

import {
  createLifecycleOwner,
  createPolling,
  createReactiveListener,
} from "./lifecycle.ts";

const TICK_MS = 5;

/** Let `count` real intervals elapse. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createPolling", () => {
  test("stops when active() flips false and restarts when it flips back", async () => {
    const [live, setLive] = createSignal(true);
    let ticks = 0;
    const dispose = createRoot((disposeRoot) => {
      createPolling({
        active: live,
        intervalMs: TICK_MS,
        tick: () => {
          ticks += 1;
        },
      });
      return disposeRoot;
    });

    await wait(TICK_MS * 6);
    const whileLive = ticks;
    expect(whileLive).toBeGreaterThan(0);

    // The job finished. A non-reactive read of `live` (the original bug) would
    // keep polling here forever.
    setLive(false);
    await wait(TICK_MS * 6);
    expect(ticks).toBe(whileLive);

    setLive(true);
    await wait(TICK_MS * 6);
    expect(ticks).toBeGreaterThan(whileLive);

    const before = ticks;
    dispose();
    await wait(TICK_MS * 6);
    expect(ticks).toBe(before);
  });

  test("does not stack ticks when one poll outlives the interval", async () => {
    let started = 0;
    const releases: (() => void)[] = [];
    const dispose = createRoot((disposeRoot) => {
      createPolling({
        active: () => true,
        intervalMs: TICK_MS,
        tick: () => {
          started += 1;
          return new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        },
      });
      return disposeRoot;
    });

    await wait(TICK_MS * 6);
    expect(started).toBe(1);
    for (const release of releases) release();
    dispose();
  });
});

describe("createLifecycleOwner", () => {
  test("dispose cancels pending timeouts and removes listeners", async () => {
    const owner = createLifecycleOwner();
    let fired = false;
    let events = 0;
    const target = new EventTarget();
    owner.timeout(TICK_MS, () => {
      fired = true;
    });
    owner.listen(target, "ping", () => {
      events += 1;
    });

    target.dispatchEvent(new Event("ping"));
    expect(events).toBe(1);

    owner.dispose();
    target.dispatchEvent(new Event("ping"));
    await wait(TICK_MS * 4);
    expect(events).toBe(1);
    expect(fired).toBe(false);
  });

  test("teardowns registered after dispose run immediately", () => {
    const owner = createLifecycleOwner();
    owner.dispose();
    let released = false;
    owner.own(() => {
      released = true;
    });
    expect(released).toBe(true);
  });
});

describe("createReactiveListener", () => {
  test("listens only while active without accumulating duplicate listeners", () => {
    const target = new EventTarget();
    const [active, setActive] = createSignal(false);
    let events = 0;
    const dispose = createRoot((disposeRoot) => {
      createReactiveListener({
        active,
        target,
        type: "ping",
        handler: () => {
          events += 1;
        },
      });
      return disposeRoot;
    });

    target.dispatchEvent(new Event("ping"));
    expect(events).toBe(0);

    setActive(true);
    target.dispatchEvent(new Event("ping"));
    expect(events).toBe(1);

    setActive(false);
    setActive(true);
    target.dispatchEvent(new Event("ping"));
    expect(events).toBe(2);

    dispose();
    target.dispatchEvent(new Event("ping"));
    expect(events).toBe(2);
  });
});
