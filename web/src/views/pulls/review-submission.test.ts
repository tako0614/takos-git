import { afterEach, expect, test } from "bun:test";
import { createReviewSubmission, type ReviewAcknowledgment, type ReviewVerdict } from "./review-submission.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  let target = { owner: "alice", repo: "project", number: 1 };
  const requests: { url: string; body: { state: ReviewVerdict; body?: string } }[] = [];
  const pending: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  globalThis.fetch = ((url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); });
  }) as typeof fetch;
  const acknowledgments: ReviewAcknowledgment[] = [], successes: ReviewVerdict[] = [];
  const flow = createReviewSubmission({
    target: () => target,
    onSubmitted: (ack) => { acknowledgments.push(ack); },
    onSuccess: (state) => { successes.push(state); },
  });
  const acknowledge = (index: number) => pending[index]!.resolve(Response.json({
    review: { id: `review-${index}`, ...requests[index]!.body },
  }, { status: 201 }));
  return { flow, requests, pending, acknowledgments, successes, acknowledge,
    setTarget: (value: typeof target) => { target = value; } };
}

for (const verdict of ["commented", "approved", "changes_requested"] as const) {
  test(`an unchanged ${verdict} ACK clears and closes only the submitted draft`, async () => {
    const f = fixture();
    f.flow.updateBody("  original review  ");
    const done = f.flow.submit(verdict);
    expect(f.flow.busy()).toBe(verdict);
    expect(f.requests).toEqual([{ url: "/api/v1/repos/alice/project/pulls/1/reviews", body: { state: verdict, body: "original review" } }]);
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
  expect(f.requests[0]!.body).toEqual({ state: "commented", body: "original" });
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
  expect(f.flow.error()).toBe("Failed to submit review.");
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
  expect(f.requests[0]!.url).toBe("/api/v1/repos/alice/project/pulls/1/reviews");
  expect(f.flow.body()).toBe("original");
  expect(f.acknowledgments).toEqual([]); expect(f.successes).toEqual([]);
});

test("empty comment reviews refuse dispatch, while an empty approval stays supported", async () => {
  const f = fixture(); f.flow.updateBody("  "); await f.flow.submit("commented");
  expect(f.requests).toHaveLength(0);
  expect(f.flow.error()).toBe("A comment review requires a message.");
  const done = f.flow.submit("approved");
  expect(f.requests[0]!.body).toEqual({ state: "approved" });
  f.acknowledge(0); await done;
  expect(f.acknowledgments).toEqual([{ keepOpen: false }]);
});
