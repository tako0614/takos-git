import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createCommentSubmission, type CommentSubmission } from "./comment-submission.ts";

const attempt = (body = "original", revision = 1): CommentSubmission => ({ body, revision, closeAfter: "closed" });

describe("comment submission recovery", () => {
  test("a lost response retains the submitted draft and refuses a fresh or concurrent POST", () => {
    const flow = createCommentSubmission(), original = attempt();
    expect(flow.begin(original)).toBe(true);
    expect(flow.begin(attempt("duplicate"))).toBe(false);
    flow.fail(original, new TypeError("Failed to fetch"));
    expect(flow.unknown()).toBe(original);
    expect(flow.begin(attempt("newer draft", 2))).toBe(false);
    expect(flow.state()?.attempt).toEqual({ body: "original", revision: 1, closeAfter: "closed" });
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
});
