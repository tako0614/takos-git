import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createPullSubmission } from "./pull-submission.ts";

describe("PR creation intent custody", () => {
  test("a fresh document restores the original unknown intent and newer form without another key", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const options = { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a" };
    let keys = 0;
    const first = createPullSubmission(() => `key-${++keys}`, options);
    const original = first.begin({ title: "original", base: "main", head: "feature" }, 1)!;
    first.fail(original, new TypeError("Lost committed response"));
    const restored = createPullSubmission(() => `key-${++keys}`, options);
    expect(restored.unknown()?.idempotencyKey).toBe("key-1");
    expect(restored.begin({ title: "another", base: "main", head: "feature" }, 2)).toBeNull();
    expect(keys).toBe(1);
    expect(restored.retry(restored.unknown()!)).toBe(true);
    expect(restored.acknowledge(restored.state()!.attempt)).toBe(true);
    expect(values.size).toBe(0);
  });

  test("saving recovery must succeed before an attempt can reach the network", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); }, removeItem: () => {} };
    const flow = createPullSubmission(() => "key", { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a" });
    expect(() => flow.begin({ title: "original", base: "main", head: "feature" }, 0)).toThrow();
    expect(flow.state()).toBeNull();
  });

  test("unknown submission retains its key and original branches through newer form edits", () => {
    let keys = 0; const flow = createPullSubmission(() => `key-${++keys}`);
    const input = { title: "original", body: "body", base: "main", head: "feature", draft: true };
    const original = flow.begin(input, 1)!;
    input.title = "newer"; input.base = "next-base"; input.head = "next-head"; input.draft = false;
    flow.fail(original, new TypeError("Lost committed response"));
    expect(flow.begin(input, 2)).toBeNull(); expect(keys).toBe(1);
    expect(flow.retry(original)).toBe(true); expect(flow.state()?.attempt.idempotencyKey).toBe("key-1");
    expect(flow.state()?.attempt.input).toEqual({ title: "original", body: "body", base: "main", head: "feature", draft: true });
    expect(flow.acknowledge(original)).toBe(true); expect(flow.begin(input, 2)?.idempotencyKey).toBe("key-2");
  });
  test("temporary denial cannot discard the uncertain original key", () => {
    const flow = createPullSubmission(() => "original-key"), original = flow.begin({ title: "original", base: "main", head: "feature" }, 1)!;
    flow.fail(original, new TypeError("Lost response"));
    for (const status of [401, 403, 404, 429, 410]) {
      expect(flow.retry(original)).toBe(true); flow.fail(original, new ApiError(status, "unavailable", "Not a receipt tombstone"));
      expect(flow.unknown()).toBe(original); expect(flow.begin({ title: "new", base: "main", head: "feature" }, 2)).toBeNull();
    }
  });
  test("only a confirmed receipt tombstone releases a lost original for a fresh intent", () => {
    let keys = 0; const flow = createPullSubmission(() => `key-${++keys}`), original = flow.begin({ title: "original", base: "main", head: "feature" }, 1)!;
    flow.fail(original, new TypeError("Lost response")); flow.retry(original); flow.fail(original, new ApiError(410, "submission_deleted", "Original removed"));
    expect(flow.state()).toBeNull(); const current = flow.begin({ title: "newer", base: "main", head: "feature" }, 2)!;
    expect(current.idempotencyKey).toBe("key-2"); flow.fail(original, new ApiError(410, "submission_deleted", "Late old result")); expect(flow.state()?.attempt).toBe(current);
  });
  test("initial validation denial allows correction without a stale ACK retiring it", () => {
    let keys = 0; const flow = createPullSubmission(() => `key-${++keys}`), old = flow.begin({ title: "invalid", base: "main", head: "main" }, 1)!;
    flow.fail(old, new ApiError(422, "identical_branches", "Rejected")); const current = flow.begin({ title: "valid", base: "main", head: "feature" }, 2)!;
    expect(current.idempotencyKey).toBe("key-2"); expect(flow.acknowledge(old)).toBe(false); expect(flow.state()?.attempt).toBe(current);
  });
});
