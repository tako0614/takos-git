import { describe, expect, test } from "bun:test";
import type { Page } from "../../api/client.ts";
import type { IssueCommentDto } from "../../api/types.ts";
import { createCommentTimeline } from "./comment-timeline.ts";

const comment = (id: string, createdAt = 1, body = id): IssueCommentDto => ({
  id, createdAt, updatedAt: createdAt, body, author: null,
});
const page = (items: IssueCommentDto[], nextCursor: string | null = null): Page<IssueCommentDto> => ({ items, nextCursor });
function seed(timeline: ReturnType<typeof createCommentTimeline>, items: IssueCommentDto[]) {
  const read = timeline.beginRead();
  timeline.accept(read, page(items), true);
  timeline.finishRead(read);
}

describe("comment timeline read/write ordering", () => {
  test("a late initial page keeps the comment already acknowledged by POST", () => {
    const timeline = createCommentTimeline();
    const read = timeline.beginRead();
    const posted = comment("posted", 3);
    timeline.acknowledge(posted);
    timeline.accept(read, page([]), true);
    timeline.finishRead(read);
    expect(timeline.items()).toEqual([posted]);
  });

  test("a late page cannot undo an edit acknowledged during its read", () => {
    const timeline = createCommentTimeline();
    const original = comment("a");
    const edited = { ...original, body: "new text", updatedAt: 9 };
    seed(timeline, [original]);
    const read = timeline.beginRead();
    timeline.acknowledge(edited);
    timeline.accept(read, page([original]), true);
    timeline.finishRead(read);
    expect(timeline.items()).toEqual([edited]);
  });

  test("a late page cannot resurrect a comment deleted during its read", () => {
    const timeline = createCommentTimeline();
    const a = comment("a"), b = comment("b", 2);
    seed(timeline, [a, b]);
    const read = timeline.beginRead();
    timeline.remove(a.id);
    timeline.accept(read, page([a, b]), true);
    timeline.finishRead(read);
    expect(timeline.items()).toEqual([b]);
  });

  test("load more deduplicates a posted row and uses the API chronology and opaque cursor", () => {
    const timeline = createCommentTimeline();
    const a = comment("a"), b = comment("b", 2), c = comment("c", 3);
    seed(timeline, [a]);
    timeline.acknowledge(c);
    const read = timeline.beginRead();
    timeline.accept(read, page([b, c], "opaque?cursor=x&limit=9"), false);
    timeline.finishRead(read);
    expect(timeline.items()).toEqual([a, b, c]);
    expect(timeline.cursor()).toBe("opaque?cursor=x&limit=9");
  });

  test("a later authoritative read can replace an earlier local edit", () => {
    const timeline = createCommentTimeline();
    timeline.acknowledge(comment("a", 1, "my old edit"));
    const fresh = comment("a", 1, "later remote edit");
    const read = timeline.beginRead();
    timeline.accept(read, page([fresh]), true);
    timeline.finishRead(read);
    expect(timeline.items()).toEqual([fresh]);
  });

  test("each pending read retains writes acknowledged after it began", () => {
    const timeline = createCommentTimeline();
    const first = timeline.beginRead(), second = timeline.beginRead();
    const a = comment("a"), b = comment("b", 2), c = comment("c", 3);
    timeline.acknowledge(c);
    timeline.accept(first, page([a]), true);
    timeline.finishRead(first);
    expect(timeline.items()).toEqual([a, c]);
    timeline.accept(second, page([a, b]), true);
    timeline.finishRead(second);
    expect(timeline.items()).toEqual([a, b, c]);
  });

  test("finishing a failed read releases it without losing acknowledged input", () => {
    const timeline = createCommentTimeline();
    const read = timeline.beginRead(), a = comment("a");
    timeline.acknowledge(a);
    timeline.finishRead(read);
    timeline.accept(read, page([]), true);
    expect(timeline.items()).toEqual([a]);
    const next = timeline.beginRead();
    timeline.accept(next, page([]), true);
    timeline.finishRead(next);
    expect(timeline.items()).toEqual([]);
  });

  test("reset retires pending reads and permits the next issue page", () => {
    const timeline = createCommentTimeline();
    const old = timeline.beginRead();
    timeline.acknowledge(comment("old"));
    timeline.reset();
    timeline.accept(old, page([comment("old")], "old-cursor"), true);
    expect(timeline.items()).toEqual([]);
    expect(timeline.cursor()).toBeNull();
    const next = timeline.beginRead(), fresh = comment("new");
    timeline.accept(next, page([fresh]), true);
    timeline.finishRead(next);
    expect(timeline.items()).toEqual([fresh]);
  });

  test("equal timestamps use the same binary id order as the server", () => {
    const timeline = createCommentTimeline();
    const a = comment("01A"), b = comment("01B"), c = comment("01C", 2);
    seed(timeline, [b, c]);
    timeline.acknowledge(a);
    expect(timeline.items()).toEqual([a, b, c]);
  });
});
