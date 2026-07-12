/**
 * Seed a repo into the object + ref store using only the pure-R2 primitives
 * (no D1). Used by tests and by any tooling that wants to publish a repo to a
 * takos-git instance.
 */

import type { ObjectStoreBinding } from "./git/types.ts";
import { putCommit } from "./git/object-store.ts";
import { createSingleFileTree } from "./git/tree-ops.ts";
import { writeRepoRefs } from "./git/refs-store.ts";
import { repositoryObjectStore } from "./git/repo-object-store.ts";

export interface SeedRepoInput {
  readonly repo: string;
  readonly branch?: string;
  readonly fileName?: string;
  readonly content: string | Uint8Array;
  readonly message?: string;
}

export interface SeededRepo {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly branch: string;
}

export async function seedRepo(
  bucket: ObjectStoreBinding,
  input: SeedRepoInput,
): Promise<SeededRepo> {
  const branch = input.branch ?? "main";
  const content =
    typeof input.content === "string"
      ? new TextEncoder().encode(input.content)
      : input.content;
  const objectStore = repositoryObjectStore(bucket, input.repo);
  const treeSha = await createSingleFileTree(
    objectStore,
    input.fileName ?? "README.md",
    content,
  );
  const signature = {
    name: "Takos Git",
    email: "git@takos.test",
    timestamp: 1_700_000_000,
    tzOffset: "+0000",
  };
  const commitSha = await putCommit(objectStore, {
    tree: treeSha,
    parents: [],
    author: signature,
    committer: signature,
    message: input.message ?? "initial commit\n",
  });
  await writeRepoRefs(bucket, input.repo, {
    refs: [{ name: `refs/heads/${branch}`, sha: commitSha }],
    defaultBranch: branch,
  });
  return { commitSha, treeSha, branch };
}
