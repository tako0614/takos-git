import { describe, expect, test } from "bun:test";

import { type GitTokenPayload, gitTokenAllows, mintGitToken, verifyGitToken } from "./git-token.ts";

const KEY = "git-token-test-key-0123456789";
const TAKOSUMI_WIRE_FIXTURE =
  "tksvc_eyJ2IjoxLCJ3cyI6InNwYWNlX3dpcmUiLCJzdWIiOiJpbnN0X3dpcmUiLCJwZngiOiJzcGFjZV93aXJlIiwiY2FwIjpbInIiLCJ3Il0sImF1ZCI6InNvdXJjZS5naXQuc21hcnRfaHR0cCIsImlhdCI6MTc4MzgxNDQwMH0._g5nzwBAW-O9FoqlddOnzAbCRWvHo-RhfW-wUA0RDZk";

function payload(over: Partial<GitTokenPayload> = {}): GitTokenPayload {
  const now = 1_000_000;
  return {
    v: 1,
    ws: "space_x",
    sub: "inst_x",
    pfx: "acme/widgets",
    cap: ["r"],
    aud: "source.git.smart_http",
    iat: now,
    ...over,
  };
}

describe("git token", () => {
  test("accepts the canonical Takosumi service-grant wire fixture", async () => {
    const result = await verifyGitToken("wire-fixture-key", TAKOSUMI_WIRE_FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      v: 1,
      ws: "space_wire",
      sub: "inst_wire",
      pfx: "space_wire",
      cap: ["r", "w"],
      aud: "source.git.smart_http",
      iat: 1_783_814_400,
    });
  });

  test("round-trips + carries the git audience", async () => {
    const token = await mintGitToken(KEY, payload());
    expect(token.startsWith("tksvc_")).toBe(true);
    const result = await verifyGitToken(KEY, token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.aud).toBe("source.git.smart_http");
  });

  test("rejects wrong key and empty prefix", async () => {
    const token = await mintGitToken(KEY, payload());
    expect((await verifyGitToken("other", token)).ok).toBe(false);
    const empty = await mintGitToken(KEY, payload({ pfx: "" }));
    expect((await verifyGitToken(KEY, empty)).ok).toBe(false);
  });

  test("confines access to the repo prefix", () => {
    const p = payload({ pfx: "acme/widgets" });
    expect(gitTokenAllows(p, "r", "acme/widgets")).toBe(true);
    expect(gitTokenAllows(p, "r", "acme/other")).toBe(false);
    expect(gitTokenAllows(p, "w", "acme/widgets")).toBe(false); // read-only token
  });
});
