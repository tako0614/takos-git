import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createIssueSubmission } from "./issue-submission.ts";

describe("Issue creation intent custody", () => {
  test("later form edits cannot replace an uncertain submitted payload or key", () => {
    let keys = 0; const flow = createIssueSubmission(() => `key-${++keys}`);
    const input = { title: "original", body: "body", labels: ["bug"], assignees: ["bob"], milestone: 1 };
    const attempt = flow.begin(input, 1)!;
    input.title = "newer"; input.labels.push("docs"); input.assignees[0] = "alice";
    expect(attempt.input).toEqual({ title: "original", body: "body", labels: ["bug"], assignees: ["bob"], milestone: 1 });
    flow.fail(attempt, new TypeError("Lost response"));
    expect(flow.begin(input, 2)).toBeNull(); expect(keys).toBe(1);
    expect(flow.retry(attempt)).toBe(true); expect(flow.state()?.attempt.idempotencyKey).toBe("key-1");
    expect(flow.state()?.attempt.input.title).toBe("original");
  });
  test("only a completed or definitively rejected intent permits a fresh key", () => {
    let keys = 0; const flow = createIssueSubmission(() => `key-${++keys}`);
    const first = flow.begin({ title: "first" }, 1)!;
    expect(flow.begin({ title: "concurrent" }, 1)).toBeNull();
    expect(flow.acknowledge(first)).toBe(true);
    const next = flow.begin({ title: "next" }, 2)!; expect(next.idempotencyKey).toBe("key-2");
    flow.fail(next, new ApiError(400, "invalid_title", "Rejected"));
    expect(flow.begin({ title: "corrected" }, 3)?.idempotencyKey).toBe("key-3");
  });
  test("a stale result cannot retire a newer intent", () => {
    const flow = createIssueSubmission(() => "local-key"), old = flow.begin({ title: "old" }, 1)!;
    flow.acknowledge(old); const current = flow.begin({ title: "current" }, 2)!;
    flow.fail(old, new Error("late")); expect(flow.acknowledge(old)).toBe(false);
    expect(flow.state()?.attempt).toBe(current);
  });
});
