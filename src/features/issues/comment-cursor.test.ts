import { describe, expect, test } from "bun:test";
import { decodeCommentCursor, encodeCommentCursor } from "./comment-cursor.ts";

describe("comment continuation cursor", () => {
  test("round trips a row anchor without depending on its continued existence", () => {
    const position = { createdAt: 1_700_000_000_123, id: "01H-COMMENT" };
    expect(decodeCommentCursor(encodeCommentCursor(position))).toEqual({ kind: "after", after: position });
  });

  test("preserves a UTF-8 id and URL query delimiters literally", () => {
    const position = { createdAt: 0, id: "日本語/:?&=+😀" };
    const query = new URLSearchParams({ cursor: encodeCommentCursor(position) });
    expect(decodeCommentCursor(new URLSearchParams(query.toString()).get("cursor"))).toEqual({ kind: "after", after: position });
  });

  test("accepts existing offset cursors unchanged", () => {
    for (const offset of [0, 2, 999, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCommentCursor(btoa(`o:${offset}`))).toEqual({ kind: "offset", offset });
    }
  });

  test("malformed or oversized cursors retain the existing first-page fallback", () => {
    const bad = [null, "", "not-base64!", "x".repeat(2049), btoa("c:{"), btoa("c:null"),
      btoa('c:{"createdAt":1,"id":"a"}'), btoa('c:[1,"a",2]'), btoa('c:[-1,"a"]'),
      btoa('c:[1.5,"a"]'), btoa(`c:[${Number.MAX_SAFE_INTEGER + 1},"a"]`),
      btoa('c:[null,"a"]'), btoa('c:["1","a"]'), btoa('c:[1,""]'),
      btoa('c:[1,"a\\u0000b"]'), btoa(`c:[1,"${"a".repeat(257)}"]`), btoa("o:2junk"), btoa("o:-1")];
    for (const cursor of bad) expect(decodeCommentCursor(cursor)).toEqual({ kind: "offset", offset: 0 });
  });
});
