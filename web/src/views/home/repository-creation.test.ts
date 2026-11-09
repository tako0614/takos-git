import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api/client.ts";
import { createRepositoryCreation } from "./repository-creation.ts";

describe("Web repository creation intent", () => {
  test("an in-flight or uncertain create retains its original namespace and configuration", () => {
    const flow = createRepositoryCreation();
    const draft = { owner: "alice", name: "original", description: "private work", visibility: "private" as const, defaultBranch: "trunk" };
    const original = flow.prepare(draft, 1)!;
    draft.owner = "other"; draft.name = "later draft"; draft.defaultBranch = "main";
    expect(original.input).toEqual({ owner: "alice", name: "original", description: "private work", visibility: "private", defaultBranch: "trunk" });
    expect(flow.prepare(draft, 2)).toBeNull();
    flow.fail(original, new TypeError("Lost response"));
    expect(flow.unknown()).toBe(original);
    expect(flow.prepare(draft, 2)).toBeNull();
    expect(flow.retry(original)).toBe(true);
    expect(flow.state()?.attempt.input.name).toBe("original");
  });

  test("denied recovery or an existing-repo conflict cannot prove the first create rolled back", () => {
    const flow = createRepositoryCreation(), original = flow.prepare({ owner: "alice", name: "one" }, 1)!;
    flow.fail(original, new TypeError("Lost committed reply"));
    for (const error of [new ApiError(403, "forbidden", "Denied"), new ApiError(409, "repo_exists", "Exists"), new ApiError(503, "unavailable", "Unavailable")]) {
      expect(flow.retry(original)).toBe(true); flow.fail(original, error);
      expect(flow.unknown()).toBe(original);
      expect(flow.prepare({ owner: "alice", name: "different" }, 2)).toBeNull();
    }
    expect(flow.retry(original)).toBe(true); expect(flow.acknowledge(original)).toBe(true);
    expect(flow.prepare({ owner: "alice", name: "different" }, 2)?.input.name).toBe("different");
  });

  test("initial validation rejection permits correction without adopting a stale result", () => {
    const flow = createRepositoryCreation(), invalid = flow.prepare({ owner: "alice", name: "invalid/name" }, 1)!;
    flow.fail(invalid, new ApiError(400, "invalid_name", "Invalid name"));
    const corrected = flow.prepare({ owner: "alice", name: "valid" }, 2)!;
    expect(corrected.input.name).toBe("valid");
    expect(flow.acknowledge(invalid)).toBe(false);
    flow.fail(invalid, new TypeError("Late failure"));
    expect(flow.state()?.attempt).toBe(corrected);
  });
});
