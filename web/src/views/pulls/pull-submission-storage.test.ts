import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createPullSubmission } from "./pull-submission.ts";

function fixture() {
  const values = new Map<string, string>();
  let writable = true, removable = true, keys = 0;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (!writable) throw new Error("Storage disabled"); values.set(key, value); },
    removeItem: (key: string) => { if (!removable) throw new Error("Storage disabled"); values.delete(key); },
  };
  const flow = (scope = "A".repeat(43), repositoryId = "repo-a") => createPullSubmission(() => `key-${++keys}`, { storage: () => storage, scope, repositoryId });
  return { values, flow, write: (allowed: boolean) => { writable = allowed; }, remove: (allowed: boolean) => { removable = allowed; } };
}
const input = { title: "original", body: "original body", base: "main", head: "feature", draft: true };

describe("current-tab PR recovery across documents", () => {
  test("a document lost during sending restores unknown without sending or minting a new key", () => {
    const f = fixture(), first = f.flow(), attempt = first.begin(input, 4)!;
    const restored = f.flow(); expect(restored.state()?.phase).toBe("unknown");
    expect(restored.unknown()?.idempotencyKey).toBe(attempt.idempotencyKey);
    expect(restored.unknown()?.revision).toBe(-1);
    expect(restored.begin(input, 5)).toBeNull(); expect(f.values.size).toBe(1);
  });
  test("newer form survives reload and is independent from the immutable original", () => {
    const f = fixture(), first = f.flow(), attempt = first.begin(input, 1)!;
    const newer = { title: " newer ", body: " newer body\n", base: "feature", head: "main", draft: false };
    first.saveDraft(newer, 6); first.fail(attempt, new TypeError("Lost reply"));
    const restored = f.flow(); expect(restored.restoredForm()).toMatchObject({ input: newer, revision: 6 });
    expect(restored.unknown()?.input).toMatchObject(input);
    expect(restored.unknown()?.input.repository_id).toBe("repo-a");
    expect(restored.unknown()?.input.recovery_scope).toBe("A".repeat(43));
    expect(restored.retry(restored.unknown()!)).toBe(true);
    expect(restored.acknowledge(restored.state()!.attempt)).toBe(true); expect(f.values.size).toBe(0);
  });
  test("another caller or recreated repository cannot recover the original input or key", () => {
    const f = fixture(), first = f.flow(); first.begin(input, 1);
    for (const other of [f.flow("B".repeat(43)), f.flow("A".repeat(43), "repo-recreated")]) {
      expect(other.unknown()).toBeNull(); expect(other.restoredForm()).toBeNull();
      expect(other.begin({ ...input, title: "other" }, 1)?.idempotencyKey).not.toBe("key-1");
    }
    expect(f.flow().unknown()?.idempotencyKey).toBe("key-1"); expect(f.values.size).toBe(3);
  });
  test("temporary denial survives another document; tombstone clears only the original", () => {
    const f = fixture(), first = f.flow(); first.begin(input, 1);
    const restored = f.flow(), attempt = restored.unknown()!; restored.retry(attempt);
    restored.fail(attempt, new ApiError(403, "forbidden", "Temporary denial"));
    expect(f.flow().unknown()?.idempotencyKey).toBe("key-1");
    restored.retry(attempt); restored.fail(attempt, new ApiError(410, "submission_deleted", "Original removed"));
    expect(f.values.size).toBe(0); expect(restored.begin(input, 2)?.idempotencyKey).toBe("key-2");
  });
  test("a late ACK from an older document cannot erase a newer saved intent", () => {
    const f = fixture(), old = f.flow(), attempt = old.begin(input, 1)!;
    const current = f.flow(), recovered = current.unknown()!; current.retry(recovered); current.acknowledge(recovered);
    const next = current.begin({ ...input, title: "next" }, 2)!;
    expect(() => old.acknowledge(attempt)).toThrow();
    expect(f.flow().unknown()?.idempotencyKey).toBe(next.idempotencyKey);
    expect(f.flow().unknown()?.input.title).toBe("next");
  });
  test("malformed or foreign-context stored data is retained and blocks a fresh request", () => {
    for (const corrupt of [(value: string) => value.slice(0, 10), (value: string) => value.replace('"repository_id":"repo-a"', '"repository_id":"foreign"')]) {
      const f = fixture(); f.flow().begin(input, 1); const key = [...f.values.keys()][0], raw = corrupt(f.values.get(key)!); f.values.set(key, raw);
      const restored = f.flow(); expect(restored.storageError()).not.toBeNull();
      expect(() => restored.begin(input, 1)).toThrow(); expect(f.values.get(key)).toBe(raw);
    }
  });
  test("blocked storage prevents a first send and can recover when storage is restored", () => {
    const f = fixture(), flow = f.flow(); f.write(false);
    expect(() => flow.begin(input, 1)).toThrow(); expect(flow.state()).toBeNull(); expect(f.values.size).toBe(0);
    f.write(true); expect(flow.begin(input, 1)).not.toBeNull(); expect(f.values.size).toBe(1);
  });
  test("failed ACK cleanup retains unknown, then explicit same-key recovery can clear it", () => {
    const f = fixture(), flow = f.flow(), attempt = flow.begin(input, 1)!; f.remove(false);
    expect(() => flow.acknowledge(attempt)).toThrow(); expect(flow.unknown()).toBe(attempt);
    expect(f.flow().unknown()?.idempotencyKey).toBe(attempt.idempotencyKey);
    f.remove(true); flow.retry(attempt); expect(flow.acknowledge(attempt)).toBe(true); expect(f.values.size).toBe(0);
  });
  test("a definitive first rejection clears its journal and permits a corrected new intent", () => {
    const f = fixture(), flow = f.flow(), attempt = flow.begin(input, 1)!;
    flow.fail(attempt, new ApiError(422, "identical_branches", "Rejected"));
    expect(f.values.size).toBe(0); expect(flow.begin({ ...input, title: "corrected" }, 2)?.idempotencyKey).toBe("key-2");
  });
});
