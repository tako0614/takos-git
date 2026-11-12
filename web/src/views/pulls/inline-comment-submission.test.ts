import { afterEach, expect, test } from "bun:test";
import { createInlineCommentSubmission } from "./inline-comment-submission.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  let target = { owner: "alice", repo: "web", number: 1, path: "src/a.ts", side: "LEFT" as "LEFT" | "RIGHT", line: 2, commitSha: "a".repeat(40), scope: "pull-1:principal-a" };
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const pending: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  const acknowledgments: { keepOpen: boolean }[] = [];
  globalThis.fetch = ((url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); });
  }) as typeof fetch;
  const flow = createInlineCommentSubmission({ target: () => target, onSubmitted: ack => acknowledgments.push(ack) });
  const acknowledge = (n = 0, override: Record<string, unknown> = {}) => pending[n]!.resolve(Response.json({ comment: { id: `comment-${n}`, ...requests[n]!.body, ...override } }, { status: 201 }));
  return { flow, requests, pending, acknowledgments, acknowledge,
    change: (patch: Partial<typeof target>) => { target = { ...target, ...patch }; } };
}

test("an unchanged inline ACK confirms and closes only its submitted draft", async () => {
  const f = fixture(); f.flow.updateBody(" original "); const done = f.flow.submit();
  expect(f.requests).toEqual([{ url: "/api/v1/repos/alice/web/pulls/1/comments", body: { body: "original", path: "src/a.ts", side: "LEFT", line: 2, commitSha: "a".repeat(40) } }]);
  expect(f.flow.busy()).toBe(true); f.acknowledge(); await done;
  expect(f.flow.body()).toBe(""); expect(f.flow.busy()).toBe(false);
  expect(f.acknowledgments).toEqual([{ keepOpen: false }]);
});

test("an inline ACK retains newer text and requires a separate explicit follow-up", async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit();
  f.flow.updateBody("newer"); await f.flow.submit(); expect(f.requests).toHaveLength(1);
  f.acknowledge(); await done;
  expect(f.flow.body()).toBe("newer"); expect(f.acknowledgments).toEqual([{ keepOpen: true }]);
  const next = f.flow.submit(); expect(f.requests[1]!.body.body).toBe("newer");
  f.acknowledge(1); await next; expect(f.flow.body()).toBe("");
});

test("edit and revert is still a newer inline draft", async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit();
  f.flow.updateBody("changed"); f.flow.updateBody("original"); f.acknowledge(); await done;
  expect(f.flow.body()).toBe("original"); expect(f.acknowledgments).toEqual([{ keepOpen: true }]);
});

for (const mode of ["503", "lost"] as const) test(`an inline ${mode} response retains input without an automatic retry`, async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit(); f.flow.updateBody("newer");
  if (mode === "503") f.pending[0]!.resolve(Response.json({ error: { code: "unavailable", message: "Unavailable" } }, { status: 503 }));
  else f.pending[0]!.reject(new Error("lost reply"));
  await done; expect(f.flow.body()).toBe("newer"); expect(f.flow.busy()).toBe(false);
  expect(f.flow.error()).toBeTruthy(); expect(f.requests).toHaveLength(1); expect(f.acknowledgments).toEqual([]);
});

for (const mismatch of [{ id: "" }, { body: "another" }, { path: "src/b.ts" }, { side: "RIGHT" }, { line: 3 }, { commitSha: "b".repeat(40) }]) test(`a mismatched inline ACK retains the original: ${Object.keys(mismatch)[0]}`, async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit(); f.acknowledge(0, mismatch); await done;
  expect(f.flow.body()).toBe("original"); expect(f.flow.error()).toContain("not confirmed"); expect(f.acknowledgments).toEqual([]);
});

test("an absent inline ACK is not a saved confirmation", async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit();
  f.pending[0]!.resolve(Response.json({}, { status: 201 })); await done;
  expect(f.flow.body()).toBe("original"); expect(f.flow.error()).toContain("not confirmed"); expect(f.acknowledgments).toEqual([]);
});

for (const result of ["ACK", "failure"] as const) test(`a retired inline composer ignores late ${result}`, async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit(); f.flow.dispose();
  if (result === "ACK") f.acknowledge(); else f.pending[0]!.reject(new Error("lost"));
  await done; await f.flow.submit(); expect(f.requests).toHaveLength(1); expect(f.acknowledgments).toEqual([]); expect(f.flow.error()).toBeNull();
});

test("session change before submit never sends the old draft under the new identity", async () => {
  const f = fixture(); f.flow.updateBody("private original"); f.change({ scope: "pull-1:principal-b" }); await f.flow.submit();
  expect(f.requests).toEqual([]); expect(f.flow.body()).toBe("private original"); expect(f.flow.error()).toContain("target changed");
});

test("a target/session change while awaiting ACK cannot clear or confirm the new scope", async () => {
  const f = fixture(); f.flow.updateBody("original"); const done = f.flow.submit();
  f.change({ repo: "another", number: 2, path: "b.ts", scope: "pull-2:principal-b" });
  f.acknowledge(); await done; await f.flow.submit();
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.url).toBe("/api/v1/repos/alice/web/pulls/1/comments");
  expect(f.flow.body()).toBe("original"); expect(f.flow.busy()).toBe(false); expect(f.acknowledgments).toEqual([]); expect(f.flow.error()).toContain("target changed");
});

test("blank and repeated busy clicks produce no additional inline write", async () => {
  const f = fixture(); f.flow.updateBody("  "); await f.flow.submit(); expect(f.requests).toEqual([]);
  f.flow.updateBody("original"); const done = f.flow.submit(); await f.flow.submit(); await f.flow.submit(); expect(f.requests).toHaveLength(1);
  f.acknowledge(); await done;
});
