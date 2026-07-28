import { afterEach, describe, expect, test } from "bun:test";

import { actionsApi } from "./actions.ts";
import { webhooksApi } from "./admin.ts";

const realFetch = globalThis.fetch;

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function captureFetch(responses: readonly unknown[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  let responseIndex = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: rawBody,
    });
    return new Response(JSON.stringify(responses[responseIndex++]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SPA route contract", () => {
  test("webhook operations use the worker's /webhooks routes and envelopes", async () => {
    const webhook = {
      id: "hook-1",
      url: "https://example.test/events",
      contentType: "application/json",
      events: ["push"],
      active: true,
      sslVerify: true,
      hasSecret: true,
      createdAt: 10,
      updatedAt: 20,
    } as const;
    const delivery = {
      id: "delivery-1",
      webhookId: "hook-1",
      event: "push",
      status: "success",
      attempt: 1,
      responseStatus: 204,
      responseMs: 12,
      error: null,
      requestHeaders: {},
      retryable: false,
      nextRetryDelayMs: null,
      nextAttemptAt: null,
      deliveredAt: 30,
      createdAt: 25,
    } as const;
    const requests = captureFetch([
      { webhooks: [webhook], nextCursor: null },
      { webhook },
      { webhook },
      { delivery },
      { deliveries: [delivery], nextCursor: null },
      { removed: true },
    ]);

    const listed = await webhooksApi.list("acme", "demo");
    const created = await webhooksApi.create("acme", "demo", {
      url: webhook.url,
      secret: "secret",
      events: ["push"],
    });
    const updated = await webhooksApi.update("acme", "demo", webhook.id, {
      active: false,
    });
    const pinged = await webhooksApi.ping("acme", "demo", webhook.id);
    const deliveries = await webhooksApi.deliveries("acme", "demo", webhook.id);
    const removed = await webhooksApi.remove("acme", "demo", webhook.id);

    expect(listed.items).toEqual([webhook]);
    expect(created.webhook).toEqual(webhook);
    expect(updated.webhook).toEqual(webhook);
    expect(pinged.delivery).toEqual(delivery);
    expect(deliveries.items).toEqual([delivery]);
    expect(removed).toEqual({ removed: true });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/v1/repos/acme/demo/webhooks",
        body: null,
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/demo/webhooks",
        body: {
          url: webhook.url,
          secret: "secret",
          events: ["push"],
        },
      },
      {
        method: "PATCH",
        path: "/api/v1/repos/acme/demo/webhooks/hook-1",
        body: { active: false },
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/demo/webhooks/hook-1/pings",
        body: null,
      },
      {
        method: "GET",
        path: "/api/v1/repos/acme/demo/webhooks/hook-1/deliveries",
        body: null,
      },
      {
        method: "DELETE",
        path: "/api/v1/repos/acme/demo/webhooks/hook-1",
        body: null,
      },
    ]);
  });

  test("Actions workflow discovery and dispatch use registered routes", async () => {
    const workflow = {
      id: "workflow-1",
      path: ".github/workflows/ci.yml",
      name: "CI",
      triggers: ["workflow_dispatch"],
      state: "active",
      parsedAt: 10,
      updatedAt: 20,
    } as const;
    const run = {
      id: "run-1",
      workflowPath: workflow.path,
      workflowId: workflow.id,
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      status: "queued",
      conclusion: null,
      runNumber: 1,
      runAttempt: 1,
      actor: null,
      queuedAt: 30,
      startedAt: null,
      completedAt: null,
      createdAt: 30,
    } as const;
    const requests = captureFetch([
      { ref: "main", workflows: [workflow] },
      { run, jobs: [], dispatched: true },
      { cancelled: true },
    ]);

    const workflows = await actionsApi.workflows("acme", "demo");
    const dispatched = await actionsApi.dispatch(
      "acme",
      "demo",
      workflow.path,
      { ref: "main", inputs: { environment: "test" } },
    );
    const cancelled = await actionsApi.cancel("acme", "demo", run.id);

    expect(workflows.items).toEqual([workflow]);
    expect(dispatched.run).toEqual(run);
    expect(cancelled).toEqual({ cancelled: true });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/v1/repos/acme/demo/actions/workflows",
        body: null,
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/demo/actions/runs",
        body: {
          workflow: ".github/workflows/ci.yml",
          ref: "main",
          inputs: { environment: "test" },
        },
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/demo/actions/runs/run-1/cancel",
        body: null,
      },
    ]);
  });

  test("does not advertise an unregistered run-stream route", () => {
    expect("runStreamUrl" in actionsApi).toBe(false);
  });
});
