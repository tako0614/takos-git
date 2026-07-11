import { describe, expect, test } from "bun:test";

import { type GitTokenPayload, gitTokenAllows, mintGitToken, verifyGitToken } from "./git-token.ts";

const KEY = "git-token-test-key-0123456789";

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
