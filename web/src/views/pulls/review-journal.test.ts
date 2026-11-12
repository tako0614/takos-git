import { expect, test } from "bun:test";
import { createReviewJournal, reviewContext, type ReviewAttempt, type ReviewJournalOptions } from "./review-journal.ts";

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => { data.set(k,v); }, removeItem: (k: string) => { data.delete(k); } };
  const options: ReviewJournalOptions = { storage: () => storage, scope: "S".repeat(43), repositoryId: "repository", issueId: "issue" };
  const attempt: ReviewAttempt = { idempotencyKey: "original-key", revision: 2, submittedRevision: 2, state: "commented", body: "original", context: reviewContext(options) };
  return { data, options, attempt, journal: createReviewJournal(options) };
}
test("a review journal round-trips original intent and newer form independently", () => {
  const f = fixture(), saved = { attempt: f.attempt, form: { body: "newer", revision: 3 } };
  f.journal.write(saved, null); expect(f.journal.read()).toEqual(saved);
  expect(() => f.journal.remove("different")).toThrow(); expect(f.journal.read()).toEqual(saved);
  f.journal.remove(f.attempt.idempotencyKey); expect(f.journal.read()).toBeNull();
});
test("another caller, repository or PR cannot read or remove this journal", () => {
  const f = fixture(); f.journal.write({ attempt: f.attempt, form: { body: "original", revision: 2 } }, null);
  const original = [...f.data];
  for (const options of [{ ...f.options, scope: "T".repeat(43) }, { ...f.options, repositoryId: "different" }, { ...f.options, issueId: "other" }]) {
    const other = createReviewJournal(options); expect(other.read()).toBeNull(); other.remove(f.attempt.idempotencyKey);
    expect([...f.data]).toEqual(original);
  }
});
test("a different unresolved intent cannot be overwritten", () => {
  const f = fixture(); f.journal.write({ attempt: f.attempt, form: { body: "original", revision: 2 } }, null);
  const before = [...f.data];
  expect(() => f.journal.write({ attempt: { ...f.attempt, idempotencyKey: "another" }, form: { body: "different", revision: 3 } }, null)).toThrow();
  expect([...f.data]).toEqual(before);
});
for (const change of [
  (s: any) => { s.version = 2; },
  (s: any) => { s.attempt.context.issue_id = "other"; },
  (s: any) => { s.attempt.state = "dismissed"; },
  (s: any) => { s.attempt.idempotencyKey = "has space"; },
  (s: any) => { s.attempt.secret = "unexpected"; },
  (s: any) => { s.form.revision = 1; },
]) {
  test(`unknown or mismatched recovery stays protected: ${change.toString()}`, () => {
    const f = fixture(); f.journal.write({ attempt: f.attempt, form: { body: "newer", revision: 3 } }, null);
    const key = [...f.data.keys()][0]!, value = JSON.parse(f.data.get(key)!); change(value);
    f.data.set(key, JSON.stringify(value)); const before = [...f.data];
    expect(() => f.journal.read()).toThrow(); expect(() => f.journal.remove(f.attempt.idempotencyKey)).toThrow();
    expect([...f.data]).toEqual(before);
  });
}


test("a target-bound journal retains its commit while a legacy journal remains readable", () => {
  const f = fixture(); const attempt = {...f.attempt, commitSha:"a".repeat(40)};
  f.journal.write({attempt,form:{body:"draft",revision:2}},null);
  expect(f.journal.read()?.attempt.commitSha).toBe(attempt.commitSha);
  f.journal.remove(attempt.idempotencyKey);
  f.journal.write({attempt:f.attempt,form:{body:"legacy",revision:2}},null);
  expect(f.journal.read()?.attempt.commitSha).toBeUndefined();
});
