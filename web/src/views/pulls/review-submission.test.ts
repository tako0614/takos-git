import { afterEach, expect, test } from "bun:test";
import { createReviewSubmission, type ReviewAcknowledgment, type ReviewVerdict } from "./review-submission.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(storage = new Map<string, string>()) {
  let target = { owner: "alice", repo: "project", number: 1 };
  const requestKeys: (string | null)[] = [];
  const requests: { url: string; body: { state: ReviewVerdict; body?: string } }[] = [];
  const pending: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  globalThis.fetch = ((url, init) => {
    requestKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); });
  }) as typeof fetch;
  const acknowledgments: ReviewAcknowledgment[] = [], successes: ReviewVerdict[] = [];
  const flow = createReviewSubmission({
    target: () => target,
    recovery: { scope: "S".repeat(43), repositoryId: "repo-1", issueId: "issue-1", storage: () => ({ getItem: k => storage.get(k) ?? null, setItem: (k,v) => { storage.set(k,v); }, removeItem: k => { storage.delete(k); } }) },
    onSubmitted: (ack) => { acknowledgments.push(ack); },
    onSuccess: (state) => { successes.push(state); },
  });
  const acknowledge = (index: number) => pending[index]!.resolve(Response.json({
    review: { id: `review-${index}`, state: requests[index]!.body.state, body: requests[index]!.body.body ?? null, createdAt: 1, commitSha: "a".repeat(40) },
  }, { status: 201 }));
  return { flow, storage, requests, requestKeys, pending, acknowledgments, successes, acknowledge,
    setTarget: (value: typeof target) => { target = value; } };
}

test("a confirmed original leaves its newer unsent draft recoverable after reload without another pending request", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented"); f.flow.updateBody("newer follow-up");
  f.acknowledge(0); await done; f.flow.dispose();
  const restored = fixture(f.storage);
  expect(restored.flow.body()).toBe("newer follow-up");
  expect(restored.flow.pending()).toBeNull(); expect(restored.requests).toEqual([]);
  const followUp = restored.flow.submit("commented");
  expect(restored.requests[0]!.body.body).toBe("newer follow-up");
  expect(restored.requestKeys[0]).not.toBe(f.requestKeys[0]);
  restored.acknowledge(0); await followUp; restored.flow.dispose();
  const after = fixture(f.storage);
  expect(after.flow.body()).toBe(""); expect(after.flow.pending()).toBeNull();
  expect(after.requests).toEqual([]);
});

for (const verdict of ["commented", "approved", "changes_requested"] as const) {
  test(`an unchanged ${verdict} ACK clears and closes only the submitted draft`, async () => {
    const f = fixture();
    f.flow.updateBody("  original review  ");
    const done = f.flow.submit(verdict);
    expect(f.flow.busy()).toBe(verdict);
    expect(f.requests).toEqual([{ url: "/api/v1/repos/alice/project/pulls/1/reviews/submissions", body: { state: verdict, body: "original review", repository_id: "repo-1", issue_id: "issue-1", recovery_scope: "S".repeat(43) } }]);
    f.acknowledge(0); await done;
    expect(f.flow.body()).toBe("");
    expect(f.flow.busy()).toBeNull();
    expect(f.acknowledgments).toEqual([{ keepOpen: false }]);
    expect(f.successes).toEqual([verdict]);
  });
}

test("an ACK keeps a newer draft open; a follow-up review requires a separate explicit submission", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented");
  f.flow.updateBody("newer unsent follow-up");
  await f.flow.submit("approved");
  expect(f.requests).toHaveLength(1);
  f.acknowledge(0); await done;
  expect(f.flow.body()).toBe("newer unsent follow-up");
  expect(f.acknowledgments).toEqual([{ keepOpen: true }]);
  expect(f.requests[0]!.body).toMatchObject({ state: "commented", body: "original" });
  expect(f.requests).toHaveLength(1);
  const followUp = f.flow.submit("commented");
  expect(f.requests[1]!.body.body).toBe("newer unsent follow-up");
  f.acknowledge(1); await followUp;
  expect(f.flow.body()).toBe("");
  expect(f.acknowledgments).toEqual([{ keepOpen: true }, { keepOpen: false }]);
});

test("an edit reverted to the same text is still a newer draft", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented");
  f.flow.updateBody("different"); f.flow.updateBody("original");
  f.acknowledge(0); await done;
  expect(f.flow.body()).toBe("original");
  expect(f.acknowledgments).toEqual([{ keepOpen: true }]);
});

test("a rejected review keeps newer input and reports the API failure without a replay", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented"); f.flow.updateBody("newer");
  f.pending[0]!.resolve(Response.json({ error: { code: "unavailable", message: "Review temporarily unavailable." } }, { status: 503 }));
  await done;
  expect(f.flow.body()).toBe("newer");
  expect(f.flow.error()).toBe("Review temporarily unavailable.");
  expect(f.flow.busy()).toBeNull();
  expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

test("a lost response keeps the draft without success effects or automatic retry", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented"); f.flow.updateBody("newer");
  f.pending[0]!.reject(new TypeError("synthetic lost ACK")); await done;
  expect(f.flow.body()).toBe("newer");
  expect(f.flow.error()).toContain("original review is unconfirmed");
  expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

for (const outcome of ["ACK", "failure"] as const) {
  test(`retiring the form suppresses its late ${outcome} and refuses new dispatch`, async () => {
    const f = fixture(); f.flow.updateBody("original");
    const done = f.flow.submit("commented"); f.flow.updateBody("newer"); f.flow.dispose();
    if (outcome === "ACK") f.acknowledge(0);
    else f.pending[0]!.reject(new Error("synthetic late failure"));
    await done; await f.flow.submit("approved");
    expect(f.flow.body()).toBe("newer"); expect(f.flow.error()).toBeNull();
    expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });
}

test("a pending review retains its original request target and cannot acknowledge another PR", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented");
  f.setTarget({ owner: "bob", repo: "other", number: 2 });
  f.acknowledge(0); await done;
  expect(f.requests[0]!.url).toBe("/api/v1/repos/alice/project/pulls/1/reviews/submissions");
  expect(f.flow.body()).toBe("original");
  expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
});

test("empty comment reviews refuse dispatch, while an empty approval stays supported", async () => {
  const f = fixture(); f.flow.updateBody("  "); await f.flow.submit("commented");
  expect(f.requests).toHaveLength(0);
  expect(f.flow.error()).toBe("A comment review requires a message.");
  const done = f.flow.submit("approved");
  expect(f.requests[0]!.body).toMatchObject({ state: "approved" });
  f.acknowledge(0); await done;
  expect(f.acknowledgments).toEqual([{ keepOpen: false }]);
});

test("reload restores original key and newer input, with no automatic request or new verdict", async () => {
  const f = fixture(); f.flow.updateBody("  original  ");
  const first = f.flow.submit("commented");
  expect(f.storage.size).toBe(1);
  f.flow.updateBody("newer unsent input");
  f.pending[0]!.reject(new TypeError("lost ACK")); await first; f.flow.dispose();
  const restored = fixture(f.storage);
  expect(restored.flow.body()).toBe("newer unsent input");
  expect(restored.flow.pending()?.phase).toBe("unknown");
  expect(restored.requests).toEqual([]);
  await restored.flow.submit("approved"); expect(restored.requests).toEqual([]);
  const retry = restored.flow.retryOriginal();
  expect(restored.requestKeys[0]).toBe(f.requestKeys[0]);
  expect(restored.requests[0]!.body).toMatchObject({ state: "commented", body: "original" });
  restored.acknowledge(0); await retry;
  expect(restored.flow.body()).toBe("newer unsent input");
  expect(restored.acknowledgments).toEqual([{ keepOpen: true }]);
  expect([...restored.storage.keys()].filter(k => k.startsWith("takos-git:pending-review:"))).toHaveLength(0);
  expect([...restored.storage.keys()].filter(k => k.startsWith("takos-git:review-draft:"))).toHaveLength(1);
});

test("reload of unchanged original input closes only after original keyed ACK", async () => {
  const f = fixture(); f.flow.updateBody("  original  ");
  const first = f.flow.submit("commented"); f.pending[0]!.reject(new TypeError("lost")); await first; f.flow.dispose();
  const restored = fixture(f.storage);
  expect(restored.flow.body()).toBe("  original  ");
  const retry = restored.flow.retryOriginal(); restored.acknowledge(0); await retry;
  expect(restored.acknowledgments).toEqual([{ keepOpen: false }]);
});

test("a rejected same-key recovery retains the earlier uncertain outcome", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const first = f.flow.submit("commented"); f.pending[0]!.reject(new TypeError("lost")); await first;
  const retry = f.flow.retryOriginal();
  f.pending[1]!.resolve(Response.json({ error: { code: "not_found", message: "Original context unavailable." } }, { status: 404 }));
  await retry;
  expect(f.flow.pending()?.phase).toBe("unknown");
  expect(f.storage.size).toBe(1); expect(f.requestKeys[1]).toBe(f.requestKeys[0]);
  await f.flow.submit("approved"); expect(f.requests).toHaveLength(2);
});

for (const response of [{}, { review: {} }, { review: { id: "bad", state: "approved", body: "different", createdAt: 1, commitSha: null } }]) {
  test(`an unverified review ACK retains the original journal: ${JSON.stringify(response)}`, async () => {
    const f = fixture(); f.flow.updateBody("original");
    const done = f.flow.submit("commented"); f.pending[0]!.resolve(Response.json(response)); await done;
    expect(f.flow.pending()?.phase).toBe("unknown"); expect(f.storage.size).toBe(1);
    expect(f.flow.body()).toBe("original"); expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
  });
}

test("write-ahead storage failure blocks POST and can be retried after storage is restored", async () => {
  const f = fixture(); let failWrite = true;
  const flow = createReviewSubmission({ target: () => ({ owner: "alice", repo: "project", number: 1 }),
    recovery: { scope: "S".repeat(43), repositoryId: "repo-1", issueId: "issue-1", storage: () => ({
      getItem: k => f.storage.get(k) ?? null, setItem: (k,v) => { if (failWrite) throw new Error("unavailable"); f.storage.set(k,v); }, removeItem: k => { f.storage.delete(k); },
    }) }, onSubmitted: () => {}, onSuccess: () => {} });
  flow.updateBody("keep this"); await flow.submit("commented");
  expect(f.requests).toEqual([]); expect(flow.body()).toBe("keep this");
  failWrite = false; const done = flow.submit("commented"); expect(f.requests).toHaveLength(1);
  f.acknowledge(0); await done; expect(flow.body()).toBe("");
});

test("missing canonical recovery metadata refuses dispatch without discarding input", async () => {
  const f = fixture(); const flow = createReviewSubmission({ target: () => ({ owner: "alice", repo: "project", number: 1 }), recovery: null, onSubmitted: () => {}, onSuccess: () => {} });
  flow.updateBody("keep this"); await flow.submit("approved");
  expect(f.requests).toEqual([]); expect(flow.body()).toBe("keep this"); expect(flow.error()).toContain("unavailable");
});

test("a failed local ACK cleanup retains the original intent for a same-key retry", async () => {
  const f = fixture(); let failRemove = true;
  const acknowledgments: ReviewAcknowledgment[] = [];
  const flow = createReviewSubmission({ target: () => ({ owner: "alice", repo: "project", number: 1 }),
    recovery: { scope: "S".repeat(43), repositoryId: "repo-1", issueId: "issue-1", storage: () => ({
      getItem: k => f.storage.get(k) ?? null, setItem: (k,v) => { f.storage.set(k,v); },
      removeItem: k => { if (failRemove) throw new Error("cleanup unavailable"); f.storage.delete(k); },
    }) }, onSubmitted: a => { acknowledgments.push(a); }, onSuccess: () => {} });
  flow.updateBody("original"); const done = flow.submit("commented"); flow.updateBody("newer");
  f.acknowledge(0); await done;
  expect(flow.pending()?.phase).toBe("unknown");
  expect([...f.storage.keys()].filter(k => k.startsWith("takos-git:pending-review:"))).toHaveLength(1);
  expect([...f.storage.keys()].filter(k => k.startsWith("takos-git:review-draft:"))).toHaveLength(1);
  expect(flow.body()).toBe("newer"); expect(acknowledgments).toEqual([]);
  failRemove = false; const retry = flow.retryOriginal(); f.acknowledge(1); await retry;
  expect(f.requestKeys[1]).toBe(f.requestKeys[0]); expect(acknowledgments).toEqual([{ keepOpen: true }]);
  expect(flow.body()).toBe("newer");
  expect([...f.storage.keys()].filter(k => k.startsWith("takos-git:pending-review:"))).toHaveLength(0);
  expect([...f.storage.keys()].filter(k => k.startsWith("takos-git:review-draft:"))).toHaveLength(1);
});

test("recovered unsent text remains stored through further editing and explicit clearing", async () => {
  const f = fixture(); f.flow.updateBody("original");
  const done = f.flow.submit("commented"); f.flow.updateBody("newer"); f.acknowledge(0); await done;
  f.flow.updateBody(""); expect(f.storage.size).toBe(0);
  f.flow.updateBody("edited again"); f.flow.dispose();
  const restored = fixture(f.storage);
  expect(restored.flow.body()).toBe("edited again"); expect(restored.flow.pending()).toBeNull();
  restored.flow.updateBody(""); restored.flow.dispose();
  expect(fixture(f.storage).flow.body()).toBe("");
});

test("failed follow-up persistence cannot retire the original receipt or report a successful ACK", async () => {
  const f = fixture(); let failDraft = true;
  const acks: ReviewAcknowledgment[] = [];
  const flow = createReviewSubmission({ target: () => ({ owner: "alice", repo: "project", number: 1 }),
    recovery: { scope: "S".repeat(43), repositoryId: "repo-1", issueId: "issue-1", storage: () => ({
      getItem: k => f.storage.get(k) ?? null,
      setItem: (k,v) => { if (failDraft && k.startsWith("takos-git:review-draft:")) throw new Error("draft unavailable"); f.storage.set(k,v); },
      removeItem: k => { f.storage.delete(k); },
    }) }, onSubmitted: ack => { acks.push(ack); }, onSuccess: () => {} });
  flow.updateBody("original"); const done = flow.submit("commented"); flow.updateBody("newer");
  f.acknowledge(0); await done;
  expect(flow.pending()?.phase).toBe("unknown"); expect(flow.body()).toBe("newer");
  expect(acks).toEqual([]); expect(flow.storageError()).not.toBeNull();
  expect([...f.storage.keys()].filter(k => k.startsWith("takos-git:pending-review:"))).toHaveLength(1);
  failDraft = false; const retry = flow.retryOriginal();
  expect(f.requestKeys[1]).toBe(f.requestKeys[0]); f.acknowledge(1); await retry;
  expect(acks).toEqual([{ keepOpen: true }]); flow.dispose();
  const restored = fixture(f.storage);
  expect(restored.flow.body()).toBe("newer"); expect(restored.flow.pending()).toBeNull();
});

test("retry cannot overwrite another retained intent or dispatch its old key", async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit("commented");
  f.pending[0]!.reject(new TypeError("lost")); await done;
  const key = [...f.storage.keys()][0]!, saved = JSON.parse(f.storage.get(key)!);
  saved.attempt.idempotencyKey = "another-original"; f.storage.set(key, JSON.stringify(saved));
  const before = [...f.storage]; await f.flow.retryOriginal();
  expect([...f.storage]).toEqual(before); expect(f.requests).toHaveLength(1);
  expect(f.flow.pending()?.phase).toBe("unknown"); expect(f.flow.storageError()).not.toBeNull();
});
