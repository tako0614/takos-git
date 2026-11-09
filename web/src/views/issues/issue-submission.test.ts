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
  test("an auth rejection during recovery cannot discard the uncertain original key", () => {
    let keys = 0; const flow = createIssueSubmission(() => `key-${++keys}`);
    const original = flow.begin({ title: "committed before lost response" }, 1)!;
    flow.fail(original, new TypeError("Lost committed reply"));
    for (const status of [401, 403, 404, 429]) {
      expect(flow.retry(original)).toBe(true);
      flow.fail(original, new ApiError(status, "rejected", "Recovery rejected"));
      expect(flow.unknown()).toBe(original);
      expect(flow.begin({ title: "committed before lost response" }, 1)).toBeNull();
      expect(keys).toBe(1);
    }
    expect(flow.retry(original)).toBe(true);
    expect(flow.acknowledge(original)).toBe(true);
    expect(flow.begin({ title: "intent after confirmed ACK" }, 2)?.idempotencyKey).toBe("key-2");
  });
});


test("reload restores the original Issue key rather than permitting a duplicate", () => {
  const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k,v); }, removeItem: (k: string) => { values.delete(k); } };
  const options = { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a" };
  const first = createIssueSubmission(() => "original-key", options), original = first.begin({ title: "original", labels: ["bug"], assignees: ["alice"], milestone: 1 }, 1)!;
  first.fail(original, new TypeError("Lost committed response"));
  const restored = createIssueSubmission(() => "another-key", options);
  expect(restored.unknown()?.idempotencyKey).toBe("original-key");
  expect(restored.begin({ title: "duplicate" }, 2)).toBeNull();
});

test("Issue storage retention is required before a first send", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("Quota"); }, removeItem: () => {} };
  const flow = createIssueSubmission(() => "key", { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a" });
  expect(() => flow.begin({ title: "original" }, 1)).toThrow(); expect(flow.state()).toBeNull();
});


function issueJournalFixture() {
  const values = new Map<string,string>();
  const storage = { getItem:(k:string)=>values.get(k)??null, setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);} };
  let key=0;
  return {values, flow:(scope="A".repeat(43),repositoryId="repo-a")=>createIssueSubmission(()=>`saved-key-${++key}`,{storage:()=>storage,scope,repositoryId})};
}
test("Issue reload retains newer triage arrays without changing the submitted intent",()=>{
  const f=issueJournalFixture(), first=f.flow(), input={title:"original",body:"original body",labels:["bug"],assignees:["alice"],milestone:1};
  const original=first.begin(input,1)!; first.fail(original,new TypeError("Lost reply"));
  const newer={title:"newer",body:" new body ",labels:["docs"],assignees:["bob"],milestone:2};first.saveDraft(newer,4);newer.labels.push("later mutation");input.assignees.push("later author");
  const restored=f.flow();expect(restored.unknown()?.input).toMatchObject({title:"original",labels:["bug"],assignees:["alice"],milestone:1});
  expect(restored.restoredForm()).toMatchObject({input:{title:"newer",body:" new body ",labels:["docs"],assignees:["bob"],milestone:2},revision:4});
  expect(restored.unknown()?.revision).toBe(-1);expect(restored.retry(restored.unknown()!)).toBe(true);expect(restored.acknowledge(restored.state()!.attempt)).toBe(true);expect(f.values.size).toBe(0);
});
test("Issue journals separate callers/repositories and retain corrupt originals without a fresh POST",()=>{
  const f=issueJournalFixture();f.flow().begin({title:"private original"},1);
  expect(f.flow("B".repeat(43)).unknown()).toBeNull();expect(f.flow("A".repeat(43),"other-repo").restoredForm()).toBeNull();
  const key=[...f.values.keys()][0];f.values.set(key,"broken original bytes");const bad=f.flow();expect(bad.storageError()).not.toBeNull();expect(()=>bad.begin({title:"new"},2)).toThrow();expect(f.values.get(key)).toBe("broken original bytes");
});
test("Issue uncertain denial stays durable until an authorized tombstone",()=>{
  const f=issueJournalFixture();f.flow().begin({title:"original"},1);const flow=f.flow(), original=flow.unknown()!;
  flow.retry(original);flow.fail(original,new ApiError(404,"not_found","denial"));expect(f.flow().unknown()?.idempotencyKey).toBe(original.idempotencyKey);
  flow.retry(original);flow.fail(original,new ApiError(410,"submission_deleted","removed"));expect(f.values.size).toBe(0);expect(flow.begin({title:"explicit fresh"},2)).not.toBeNull();
});
