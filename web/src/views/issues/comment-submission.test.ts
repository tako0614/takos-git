import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createCommentSubmission, type CommentSubmission } from "./comment-submission.ts";

const attempt = (body = "original", revision = 1): CommentSubmission => ({ body, revision, closeAfter: "closed", idempotencyKey: `local-key-${revision}` });

describe("comment submission recovery", () => {
  test("a lost response retains the submitted draft and refuses a fresh or concurrent POST", () => {
    const flow = createCommentSubmission(), original = attempt();
    expect(flow.begin(original)).toBe(true);
    expect(flow.begin(attempt("duplicate"))).toBe(false);
    flow.fail(original, new TypeError("Failed to fetch"));
    expect(flow.unknown()).toBe(original);
    expect(flow.begin(attempt("newer draft", 2))).toBe(false);
    expect(flow.state()?.attempt).toEqual({ body: "original", revision: 1, closeAfter: "closed", idempotencyKey: "local-key-1" });
  });

  test("timeouts, malformed responses and proxy/server failures stay uncertain", () => {
    for (const error of [new DOMException("Timeout", "AbortError"), new SyntaxError("Invalid JSON"),
      new ApiError(408, "timeout", "Timeout"), new ApiError(502, "gateway", "Gateway"), new ApiError(503, "unavailable", "Unavailable")]) {
      const flow = createCommentSubmission(), original = attempt();
      flow.begin(original); flow.fail(original, error);
      expect(flow.unknown()).toBe(original);
    }
  });

  test("a definitive rejected request releases the composer without claiming an ACK", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const flow = createCommentSubmission(), original = attempt();
      flow.begin(original); flow.fail(original, new ApiError(status, "rejected", "Rejected"));
      expect(flow.state()).toBeNull();
      expect(flow.unknown()).toBeNull();
      expect(flow.begin(attempt("corrected", 2))).toBe(true);
    }
  });

  test("explicit retry belongs to the original attempt and cannot repeat while sending", () => {
    const flow = createCommentSubmission(), original = attempt(), different = attempt("newer", 2);
    flow.begin(original); flow.fail(original, new TypeError("Lost reply"));
    expect(flow.retry(different)).toBe(false);
    expect(flow.retry(original)).toBe(true);
    expect(flow.state()?.attempt.idempotencyKey).toBe("local-key-1");
    expect(flow.state()?.phase).toBe("sending");
    expect(flow.retry(original)).toBe(false);
    expect(flow.resolve(original)).toBe(false);
    expect(flow.acknowledge(original)).toBe(true);
    expect(flow.state()).toBeNull();
  });

  test("reconciliation retires only the captured uncertain attempt, not a newer draft", () => {
    const flow = createCommentSubmission(), original = attempt(), newer = attempt("newer", 2);
    flow.begin(original); flow.fail(original, new Error("Unknown"));
    expect(flow.resolve(newer)).toBe(false);
    expect(flow.unknown()).toBe(original);
    expect(flow.resolve(original)).toBe(true);
    flow.begin(newer);
    flow.fail(original, new Error("late"));
    expect(flow.acknowledge(original)).toBe(false);
    expect(flow.state()?.attempt).toBe(newer);
  });

  test("a different issue owns separate recovery state", () => {
    const a = createCommentSubmission(), b = createCommentSubmission(), original = attempt();
    a.begin(original); a.fail(original, new Error("Lost"));
    expect(b.unknown()).toBeNull();
    expect(b.retry(original)).toBe(false);
    expect(b.begin(attempt("other issue"))).toBe(true);
  });
  test("rejected recovery keeps the original uncertain comment until a confirmed result", () => {
    const flow = createCommentSubmission(), original = attempt();
    flow.begin(original); flow.fail(original, new TypeError("Lost committed reply"));
    expect(flow.retry(original)).toBe(true);
    flow.fail(original, new ApiError(403, "forbidden", "Temporarily revoked"));
    expect(flow.unknown()).toBe(original);
    expect(flow.begin(attempt("same body with a fresh key", 2))).toBe(false);
    expect(flow.retry(original)).toBe(true);
    expect(flow.acknowledge(original)).toBe(true);
    expect(flow.begin(attempt("intent after confirmed ACK", 2))).toBe(true);
  });
});


test("reload restores the original comment, key and close-after intent", () => {
  const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k,v); }, removeItem: (k: string) => { values.delete(k); } };
  const options = { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a", issueId: "issue-a" };
  const first = createCommentSubmission(options), original = { ...attempt(), context: { repository_id: options.repositoryId, recovery_scope: options.scope, issue_id: options.issueId } };
  first.begin(original); first.fail(original, new TypeError("Lost committed response"));
  const restored = createCommentSubmission(options);
  expect(restored.unknown()?.idempotencyKey).toBe(original.idempotencyKey);
  expect(restored.unknown()?.closeAfter).toBe("closed"); expect(restored.begin(attempt("duplicate",2))).toBe(false);
});

test("comment storage retention is required before a first send", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("Quota"); }, removeItem: () => {} };
  const options = { storage: () => storage, scope: "A".repeat(43), repositoryId: "repo-a", issueId: "issue-a" };
  const flow = createCommentSubmission(options), original = { ...attempt(), context: { repository_id: options.repositoryId, recovery_scope: options.scope, issue_id: options.issueId } };
  expect(() => flow.begin(original)).toThrow(); expect(flow.state()).toBeNull();
});


function commentJournalFixture() {
  const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
  return {values,flow:(scope="A".repeat(43),issueId="issue-a",repositoryId="repo-a")=>createCommentSubmission({storage:()=>storage,scope,repositoryId,issueId})};
}
test("comment reload preserves newer draft and the original close-after target",()=>{
  const f=commentJournalFixture(), first=f.flow(), original={...attempt(),context:first.context};first.begin(original);first.fail(original,new TypeError("Lost"));first.saveDraft("newer draft",4);
  const restored=f.flow();expect(restored.restoredForm()).toEqual({body:"newer draft",revision:4});expect(restored.unknown()).toMatchObject({body:"original",closeAfter:"closed",revision:-1,context:first.context});
  expect(restored.retry(restored.unknown()!)).toBe(true);expect(restored.acknowledge(restored.state()!.attempt)).toBe(true);expect(f.values.size).toBe(0);
});
test("comment journals cannot move a pending body to another caller, repository or Issue",()=>{
  const f=commentJournalFixture(), first=f.flow();first.begin({...attempt(),context:first.context});
  for(const other of [f.flow("B".repeat(43)),f.flow("A".repeat(43),"issue-b"),f.flow("A".repeat(43),"issue-a","repo-b")]){expect(other.unknown()).toBeNull();expect(other.restoredForm()).toBeNull();}
  const bad={...attempt(),context:{...first.context,issue_id:"issue-b"}};const other=f.flow("B".repeat(43));expect(()=>other.begin(bad)).toThrow();expect(f.values.size).toBe(1);
});
test("manual resolution from an old document cannot discard a newer saved comment",()=>{
  const f=commentJournalFixture(), old=f.flow(), original={...attempt(),context:old.context};old.begin(original);old.fail(original,new TypeError("Lost"));
  const current=f.flow();expect(current.resolve(current.unknown()!)).toBe(true);const next={...attempt("next",2),context:current.context};current.begin(next);
  expect(old.resolve(original)).toBe(false);expect(f.flow().unknown()?.idempotencyKey).toBe(next.idempotencyKey);expect(f.flow().unknown()?.body).toBe("next");
});
test("a deleted original comment clears only its pending intent",()=>{
  const f=commentJournalFixture(), first=f.flow();first.begin({...attempt(),context:first.context});const restored=f.flow(), original=restored.unknown()!;
  restored.retry(original);restored.fail(original,new ApiError(403,"forbidden","temporary"));expect(f.values.size).toBe(1);
  restored.retry(original);restored.fail(original,new ApiError(410,"submission_deleted","gone"));expect(f.values.size).toBe(0);expect(restored.state()).toBeNull();
});


test("stored context cannot smuggle comment content into a state-only follow-up",()=>{
  const f=commentJournalFixture(), first=f.flow(), original={...attempt(),context:first.context};first.begin(original);
  const key=[...f.values.keys()][0], saved=JSON.parse(f.values.get(key)!);saved.attempt.context.body=original.body;const raw=JSON.stringify(saved);f.values.set(key,raw);
  const restored=f.flow();expect(restored.storageError()).not.toBeNull();expect(restored.unknown()).toBeNull();
  expect(()=>restored.begin({...attempt("new",2),context:restored.context})).toThrow();expect(f.values.get(key)).toBe(raw);
});
