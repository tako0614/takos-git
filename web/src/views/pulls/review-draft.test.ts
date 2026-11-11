import { expect, test } from "bun:test";
import { createReviewDraftStore } from "./review-draft.ts";
import type { ReviewJournalOptions } from "./review-journal.ts";

function fixture() {
  const values = new Map<string, string>();
  const options: ReviewJournalOptions = { scope: "S".repeat(43), repositoryId: "repo", issueId: "issue",
    storage: () => ({ getItem: k => values.get(k) ?? null, setItem: (k,v) => { values.set(k,v); }, removeItem: k => { values.delete(k); } }) };
  return { values, options, store: createReviewDraftStore(options) };
}
test("unsent text round-trips separately from any pending request and is removed only by its owner", () => {
  const f = fixture(), form = { body: "keep my exact\nfollow-up ", revision: 4 };
  const raw = f.store.write(form, null);
  expect(f.store.read()).toEqual({ raw, form });
  expect(raw).not.toContain("idempotencyKey");
  expect(() => f.store.write({ body: "", revision: 5 }, null)).toThrow();
  expect(f.store.read()?.form).toEqual(form);
  expect(f.store.write({ body: "", revision: 5 }, raw)).toBeNull();
  expect(f.store.read()).toBeNull();
});
test("caller, repository and PR changes cannot read or clear another draft", () => {
  const f = fixture(); f.store.write({ body: "private unsent", revision: 1 }, null);
  const before = [...f.values];
  for (const change of [{ scope: "T".repeat(43) }, { repositoryId: "other" }, { issueId: "other" }]) {
    const other = createReviewDraftStore({ ...f.options, ...change });
    expect(other.read()).toBeNull(); other.write({ body: "", revision: 0 }, null);
    expect([...f.values]).toEqual(before);
  }
});
test("stale form cannot overwrite or erase a newer retained draft", () => {
  const f = fixture(), first = f.store.write({ body: "first", revision: 1 }, null);
  const second = f.store.write({ body: "second", revision: 2 }, first);
  for (const body of ["stale write", ""]) expect(() => f.store.write({ body, revision: 3 }, first)).toThrow();
  expect(f.store.read()).toEqual({ raw: second, form: { body: "second", revision: 2 } });
});
for (const mutate of [
  (v: any) => { v.version = 2; },
  (v: any) => { v.scope = "other"; },
  (v: any) => { v.form.revision = -1; },
  (v: any) => { v.form.body = 1; },
  (v: any) => { v.form.secret = "unexpected"; },
]) {
  test(`unknown draft remains protected: ${mutate.toString()}`, () => {
    const f = fixture(); f.store.write({ body: "kept", revision: 1 }, null);
    const key = [...f.values.keys()][0]!, value = JSON.parse(f.values.get(key)!); mutate(value);
    f.values.set(key, JSON.stringify(value)); const before = [...f.values];
    expect(() => f.store.read()).toThrow();
    expect(() => f.store.write({ body: "", revision: 2 }, null)).toThrow();
    expect([...f.values]).toEqual(before);
  });
}
