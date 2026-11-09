import { afterEach, describe, expect, test } from "bun:test";

import { actionsApi } from "./actions.ts";
import { webhooksApi } from "./admin.ts";
import { issuesApi } from "./issues.ts";
import { pullsApi } from "./pulls.ts";

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
  test("issue filters survive first-page limit and later-page cursor", async () => {
    const requests = captureFetch([
      { issues: [], nextCursor: "next" },
      { issues: [], nextCursor: null },
    ]);
    await issuesApi.list("alice", "web", { state: "closed", limit: 1 });
    await issuesApi.list("alice", "web", { state: "closed", limit: 1, cursor: "next/page" });

    for (const request of requests) {
      const url = new URL(request.path, "https://fixture.example");
      expect(url.searchParams.get("state")).toBe("closed");
      expect(url.searchParams.get("limit")).toBe("1");
    }
    expect(new URL(requests[1].path, "https://fixture.example").searchParams.get("cursor")).toBe("next/page");
  });

  test("issue filter values containing delimiters stay literal during pagination", async () => {
    const requests = captureFetch([{ issues: [], nextCursor: null }]);
    await issuesApi.list("alice", "web", {
      state: "closed", label: "bug & regression?", assignee: "person:1", milestone: 2,
      limit: 3, cursor: "offset/next?label=other&limit=999",
    });
    const url = new URL(requests[0].path, "https://fixture.example");
    expect(url.searchParams.get("state")).toBe("closed");
    expect(url.searchParams.get("label")).toBe("bug & regression?");
    expect(url.searchParams.get("assignee")).toBe("person:1");
    expect(url.searchParams.get("milestone")).toBe("2");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("cursor")).toBe("offset/next?label=other&limit=999");
  });

  test("merge, resolve and explicit status recovery preserve the committed-but-pending receipt", async () => {
    const pull = { number: 7, state: "open", merged: false };
    const receipt = { pull_request: pull, merge_commit: "c".repeat(40), metadata_pending: true };
    const requests = captureFetch([receipt, receipt, { ...receipt, metadata_pending: undefined }]);
    expect(await pullsApi.merge("alice", "web", 7, { method: "squash" })).toEqual({ pull, mergeCommit: receipt.merge_commit, metadataPending: true });
    expect(await pullsApi.resolve("alice", "web", 7, { resolutions: [] })).toEqual({ pull, mergeCommit: receipt.merge_commit, metadataPending: true });
    expect((await pullsApi.reconcile("alice", "web", 7)).metadataPending).toBe(false);
    expect(requests.map(r => r.path)).toEqual([
      "/api/v1/repos/alice/web/pulls/7/merge", "/api/v1/repos/alice/web/pulls/7/resolve", "/api/v1/repos/alice/web/pulls/7/reconcile",
    ]);
  });
  test("pull lists decode the worker envelope without corrupting filter pagination", async () => {
    const pull = { number: 7, title: "Visible PR", state: "open", merged: false };
    const requests = captureFetch([{ pull_requests: [pull], nextCursor: "next" }]);

    const result = await pullsApi.list("alice", "web", {
      state: "open", limit: 1, cursor: "before",
    });

    expect(result.items).toEqual([pull]);
    expect(result.nextCursor).toBe("next");
    const url = new URL(requests[0].path, "https://fixture.example");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("cursor")).toBe("before");
  });

  test("pull filters and pagination share one query string", async () => {
    const requests = captureFetch([{ pull_requests: [], nextCursor: null }]);
    await pullsApi.list("alice", "web", { state: "closed", limit: 2, cursor: "a/b" });

    const url = new URL(requests[0].path, "https://fixture.example");
    expect(url.searchParams.get("state")).toBe("closed");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("cursor")).toBe("a/b");
  });

  test("pull detail and lifecycle writes expose the pull expected by views", async () => {
    const pull = { number: 7, title: "Existing PR", state: "open", merged: false };
    const requests = captureFetch(Array.from({ length: 5 }, () => ({ pull_request: pull })));
    const results = [
      await pullsApi.get("alice", "web", 7),
      await pullsApi.create("alice", "web", { title: pull.title, head: "feature", base: "main" }),
      await pullsApi.update("alice", "web", 7, { title: "Edited PR" }),
      await pullsApi.close("alice", "web", 7),
      await pullsApi.reopen("alice", "web", 7),
    ];

    for (const result of results) expect(result.pull).toEqual(pull);
    expect(requests.map(r => [r.method, r.path])).toEqual([
      ["GET", "/api/v1/repos/alice/web/pulls/7"],
      ["POST", "/api/v1/repos/alice/web/pulls"],
      ["PATCH", "/api/v1/repos/alice/web/pulls/7"],
      ["POST", "/api/v1/repos/alice/web/pulls/7/close"],
      ["POST", "/api/v1/repos/alice/web/pulls/7/reopen"],
    ]);
  });

  test("pull merge sends the user's message using the worker contract", async () => {
    const pull = { number: 7, state: "closed", merged: true };
    const requests = captureFetch([{ pull_request: pull, merge_commit: "a".repeat(40) }]);

    const result = await pullsApi.merge("alice", "web", 7, {
      method: "squash", commitMessage: "Keep this exact message",
    });

    expect(requests[0].body).toEqual({ method: "squash", commit_message: "Keep this exact message" });
    expect(result.pull).toEqual(pull);
    expect(result.mergeCommit).toBe("a".repeat(40));
  });

  test("pull merge combines a supplied title and body without dropping either", async () => {
    const requests = captureFetch([{ pull_request: { number: 7 }, merge_commit: "b".repeat(40) }]);
    await pullsApi.merge("alice", "web", 7, {
      method: "merge", commitTitle: "Subject", commitMessage: "Body line one\nBody line two",
    });

    expect(requests[0].body).toEqual({ method: "merge", commit_message: "Subject\n\nBody line one\nBody line two" });
  });

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
