/**
 * Regression harness for the dropped issue-webhook defect.
 *
 * Every issue mutation fired its webhook as an unowned promise from a worker
 * whose `fetch` signature never took an `ExecutionContext`. In-process (and in
 * every previous test) the promise still ran, so the suite was green while the
 * deployed Worker cancelled the delivery the instant it answered the client.
 *
 * These tests run the real route → real event sink → real `dispatchWebhook`
 * against a {@link strictExecutionContext} that reproduces the cancellation:
 * anything not handed to `waitUntil` loses its bindings at the Response. The
 * first test therefore fails if the delivery is ever un-owned again; the second
 * pins the no-ExecutionContext embedder path, where the delivery must instead be
 * finished BEFORE the Response.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { createGitWorker } from "../../worker.ts";
import { deferredScope } from "../../lifecycle.ts";
import { strictExecutionContext } from "../../lifecycle-testkit.ts";
import { installEventBridge } from "../event-bridge.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerWebhookRoutes } from "../webhooks/routes.ts";
import { registerIssuesRoutes } from "./routes.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv } from "../repos/testkit.ts";

const tokens = interfaceUserInfoFetch({
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture outbound webhook POSTs; the bridge uses the global fetch. */
function captureDeliveries(): { url: string; body: string }[] {
  const seen: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://hook.example/")) {
      return realFetch(input as RequestInfo, init);
    }
    seen.push({ url, body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return seen;
}

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerRepoRoutes(reg);
  registerWebhookRoutes(reg);
  registerIssuesRoutes(reg);
  return reg;
}

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  scope?: Parameters<RouteRegistry["handle"]>[0]["scope"],
): Promise<Response> {
  const res = await reg.handle({
    request,
    env,
    interfaceUserInfoFetch: tokens,
    ...(scope ? { scope } : {}),
  });
  if (!res) throw new Error("route was not handled");
  return res;
}

/** alice/web + a hook subscribed to `issues`. Returns the ready env + registry. */
async function seed(): Promise<{ reg: RouteRegistry; env: RouterEnv; fake: unknown }> {
  const handle = makeEnv();
  (handle.env as unknown as Record<string, unknown>).WEBHOOK_SECRET_KEY =
    "test-webhook-encryption-key";
  const reg = router();
  await dispatch(
    reg,
    jsonRequest(
      "POST",
      "/api/v1/repos",
      { owner: "alice", name: "web", visibility: "private" },
      "taksrv_alice_w",
    ),
    handle.env,
  );
  const hook = await dispatch(
    reg,
    jsonRequest(
      "POST",
      "/api/v1/repos/alice/web/webhooks",
      {
        url: "https://hook.example/receive",
        events: ["issues"],
        secret: "s3cr3t",
      },
      "taksrv_alice_a",
    ),
    handle.env,
  );
  expect(hook.status).toBe(201);
  return { reg, env: handle.env, fake: handle.fake };
}

describe("issue webhook delivery lifecycle", () => {
  test("delivery is owned by waitUntil and survives the Response", async () => {
    const { reg, env, fake } = await seed();
    const deliveries = captureDeliveries();
    const ctx = strictExecutionContext();

    // Guard the D1 binding the SINK will use: once the invocation closes, any
    // query from cancelled work throws instead of silently succeeding in-process.
    installEventBridge({
      ...(env as Record<string, unknown>),
      DB: ctx.guard(fake as object),
    } as never);

    const res = await dispatch(
      reg,
      jsonRequest(
        "POST",
        "/api/v1/repos/alice/web/issues",
        { title: "background delivery" },
        "taksrv_alice_w",
      ),
      env,
      deferredScope(ctx),
    );
    expect(res.status).toBe(201);

    // The client has its answer. Unowned work would be dead from here.
    ctx.endInvocation();
    // The route registry owns exactly the issue delivery. Request-level
    // maintenance is a Worker-entrypoint concern, not a router concern.
    expect(ctx.registered).toBe(1);

    await ctx.drain();
    expect(deliveries).toHaveLength(1);
    const body = JSON.parse(deliveries[0]!.body) as {
      event: string;
      payload: { action: string; number: number };
    };
    expect(body.event).toBe("issues");
    expect(body.payload.action).toBe("issue.opened");
    expect(body.payload.number).toBe(1);
  });

  test("without an ExecutionContext the delivery completes before the Response", async () => {
    const { reg, env } = await seed();
    const deliveries = captureDeliveries();
    installEventBridge(env as never);

    // No `scope` passed: the dispatch owns the work and drains it inline. Slower,
    // never dropped — the property that makes the missing-ctx case safe.
    const res = await dispatch(
      reg,
      jsonRequest(
        "POST",
        "/api/v1/repos/alice/web/issues",
        { title: "inline delivery" },
        "taksrv_alice_w",
      ),
      env,
    );
    expect(res.status).toBe(201);
    expect(deliveries).toHaveLength(1);
  });

  test("worker.fetch threads the runtime ExecutionContext into the scope", async () => {
    // The defect's root cause was `fetch(request, env)` — a two-argument
    // signature that discarded the ctx the runtime was already passing. This
    // exercises the real entrypoint so the argument cannot be dropped again.
    const { env } = await seed();
    const deliveries = captureDeliveries();
    const ctx = strictExecutionContext();
    const worker = createGitWorker(tokens);
    const res = await worker.fetch(
      new Request("https://git.example/api/v1/repos/alice/web/issues", {
        method: "POST",
        headers: {
          authorization: "Bearer taksrv_alice_w",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "via worker entrypoint" }),
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(201);
    ctx.endInvocation();
    // The Worker owns both the event delivery and its bounded maintenance drain.
    expect(ctx.registered).toBe(2);
    await ctx.drain();
    expect(deliveries).toHaveLength(1);
  });

  test("a failing delivery never disturbs the mutation that committed", async () => {
    const { reg, env } = await seed();
    globalThis.fetch = (async () => {
      throw new Error("hook unreachable");
    }) as typeof fetch;
    installEventBridge(env as never);

    const res = await dispatch(
      reg,
      jsonRequest(
        "POST",
        "/api/v1/repos/alice/web/issues",
        { title: "hook down" },
        "taksrv_alice_w",
      ),
      env,
    );
    expect(res.status).toBe(201);
  });
});
