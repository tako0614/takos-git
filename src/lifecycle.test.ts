import { describe, expect, test } from "bun:test";

import { deferredScope, inlineScope, requestScope } from "./lifecycle.ts";
import {
  BindingAfterResponseError,
  recordingLog,
  strictExecutionContext,
} from "./lifecycle-testkit.ts";

describe("BackgroundScope", () => {
  test("deferredScope registers the work with waitUntil", async () => {
    const ctx = strictExecutionContext();
    let ran = false;
    deferredScope(ctx).run("task", async () => {
      ran = true;
    });
    expect(ctx.registered).toBe(1);
    ctx.endInvocation();
    await ctx.drain();
    expect(ran).toBe(true);
  });

  test("inlineScope finishes its work in settled(), including nested work", async () => {
    const scope = inlineScope();
    const order: string[] = [];
    scope.run("outer", async () => {
      await Promise.resolve();
      order.push("outer");
      scope.run("nested", async () => {
        await Promise.resolve();
        order.push("nested");
      });
    });
    // Nothing has resumed past its first await yet: settled() is what carries
    // the work to completion, and it also waits for work the work started.
    expect(order).toEqual([]);
    await scope.settled();
    expect(order).toEqual(["outer", "nested"]);
  });

  test("a rejecting task is logged, never rethrown, never unhandled", async () => {
    const { log, entries } = recordingLog();
    const scope = inlineScope(log);
    scope.run("boom", async () => {
      throw new Error("nope");
    });
    // A synchronous throw is funnelled through the same single catch.
    scope.run("sync-boom", () => {
      throw new Error("also nope");
    });
    await scope.settled();
    // A sync throw is logged eagerly, an async rejection on a later microtask;
    // what matters is that both arrive and neither escapes run().
    expect([...entries.map((entry) => entry.label)].sort()).toEqual([
      "boom",
      "sync-boom",
    ]);
  });

  test("requestScope picks deferred with a ctx and inline without one", async () => {
    const ctx = strictExecutionContext();
    requestScope(ctx).run("deferred", async () => {});
    expect(ctx.registered).toBe(1);

    let ran = false;
    const inline = requestScope(undefined);
    inline.run("inline", async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(ran).toBe(false);
    await inline.settled();
    expect(ran).toBe(true);
  });
});

describe("strictExecutionContext (harness self-check)", () => {
  // If this stopped failing, the harness would no longer be able to catch a
  // dropped delivery — the exact way the original defect stayed green.
  test("unregistered work loses its bindings at the Response", async () => {
    const ctx = strictExecutionContext();
    const binding = ctx.guard({ query: async () => "row" });
    ctx.endInvocation();
    expect(() => binding.query()).toThrow(BindingAfterResponseError);
  });

  test("registered work keeps its bindings until drain completes", async () => {
    const ctx = strictExecutionContext();
    const binding = ctx.guard({ query: async () => "row" });
    let seen: string | null = null;
    ctx.waitUntil(
      (async () => {
        await Promise.resolve();
        seen = await binding.query();
      })(),
    );
    ctx.endInvocation();
    await ctx.drain();
    expect(seen).toBe("row");
    expect(() => binding.query()).toThrow(BindingAfterResponseError);
  });

  test("waitUntil after the Response is rejected", () => {
    const ctx = strictExecutionContext();
    ctx.endInvocation();
    expect(() => ctx.waitUntil(Promise.resolve())).toThrow(/waitUntil called after/u);
  });
});
