import { expect, test } from "bun:test";
import { createCommentSubmission } from "../issues/comment-submission.ts";
import { acknowledgeCommentReceipt } from "./comment-receipt.ts";

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const options = { storage: () => storage, scope: "A".repeat(43), repositoryId: "actual-repo-fixture", issueId: "actual-pr-issue-fixture" };
  const flow = createCommentSubmission(options);
  const attempt = { body: "Original PR comment", revision: 1, idempotencyKey: "original-pr-comment-key", context: flow.context };
  flow.begin(attempt);
  const receipt = { comment: { id: "comment-from-ack", body: attempt.body, author: null, createdAt: 1000, updatedAt: 1000 } };
  return { values, flow, attempt, receipt, restore: () => createCommentSubmission(options) };
}

test("empty, partial and mismatched success responses retain the original PR comment for same-key recovery", () => {
  const valid = fixture().receipt.comment;
  for (const response of [undefined, null, {}, { comment: null }, { comment: {} },
    { comment: { ...valid, id: "" } }, { comment: { ...valid, body: "Different comment" } },
    { comment: { ...valid, createdAt: NaN } }, { comment: { ...valid, updatedAt: undefined } }]) {
    const f = fixture();
    expect(() => acknowledgeCommentReceipt(f.flow, f.attempt, response)).toThrow();
    expect(f.flow.state()?.attempt).toBe(f.attempt);
    expect(f.values.size).toBe(1);
    f.flow.fail(f.attempt, new TypeError("Unconfirmed response"));
    const restored = f.restore(), original = restored.unknown()!;
    expect(original.idempotencyKey).toBe(f.attempt.idempotencyKey);
    expect(original.body).toBe(f.attempt.body);
    expect(restored.retry(original)).toBe(true);
    expect(acknowledgeCommentReceipt(restored, original, f.receipt)).toEqual(f.receipt.comment);
    expect(f.values.size).toBe(0);
  }
});

test("a real comment ACK retires only the sending attempt", () => {
  const f = fixture();
  expect(acknowledgeCommentReceipt(f.flow, { ...f.attempt }, f.receipt)).toBeNull();
  expect(f.flow.state()?.attempt).toBe(f.attempt); expect(f.values.size).toBe(1);
  expect(acknowledgeCommentReceipt(f.flow, f.attempt, f.receipt)).toBe(f.receipt.comment);
  expect(f.flow.state()).toBeNull(); expect(f.values.size).toBe(0);
});
