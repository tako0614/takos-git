import { describe, expect, test } from "bun:test";

import { mintRunnerToken, verifyRunnerToken } from "./hmac.ts";

const SECRET = "k".repeat(40);

describe("runner HMAC token", () => {
  test("round-trips claims", async () => {
    const now = 1_000_000;
    const token = await mintRunnerToken(SECRET, { runId: "r1", jobId: "j1" }, now);
    const claims = await verifyRunnerToken(SECRET, token, now);
    expect(claims).toMatchObject({ runId: "r1", jobId: "j1" });
    expect(claims!.exp).toBeGreaterThan(now);
  });

  test("rejects a tampered signature", async () => {
    const token = await mintRunnerToken(SECRET, { runId: "r1", jobId: "j1" }, 0);
    const tampered = `${token.slice(0, -2)}xx`;
    expect(await verifyRunnerToken(SECRET, tampered, 0)).toBe(null);
  });

  test("rejects the wrong secret", async () => {
    const token = await mintRunnerToken(SECRET, { runId: "r1", jobId: "j1" }, 0);
    expect(await verifyRunnerToken("other".repeat(8), token, 0)).toBe(null);
  });

  test("rejects an expired token", async () => {
    const token = await mintRunnerToken(SECRET, { runId: "r1", jobId: "j1" }, 0, 1000);
    expect(await verifyRunnerToken(SECRET, token, 5000)).toBe(null);
  });

  test("fail-closed on an empty secret", async () => {
    const token = await mintRunnerToken(SECRET, { runId: "r1", jobId: "j1" }, 0);
    expect(await verifyRunnerToken(undefined, token, 0)).toBe(null);
    expect(await verifyRunnerToken("", token, 0)).toBe(null);
  });
});
