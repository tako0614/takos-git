import assert from "node:assert/strict";
import {
  TAKOS_GIT_CAPABILITIES,
  TAKOS_GIT_INTERNAL_PATHS,
} from "./internal-api.ts";

Deno.test("Git contract exposes only Git-owned paths and capabilities", () => {
  assert.equal(TAKOS_GIT_INTERNAL_PATHS.repositories, "/internal/repositories");
  assert.equal(
    TAKOS_GIT_INTERNAL_PATHS.repository("repo/one"),
    "/internal/repositories/repo%2Fone",
  );
  assert.equal(
    TAKOS_GIT_INTERNAL_PATHS.object("repo/one", "abc123"),
    "/internal/objects/repo%2Fone/abc123",
  );
  assert.deepEqual(TAKOS_GIT_CAPABILITIES, {
    repoRead: "git.repo.read",
    repoWrite: "git.repo.write",
    objectRead: "git.object.read",
    refResolve: "git.ref.resolve",
  });
});
