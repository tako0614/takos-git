/**
 * Pure-R2 object reachability for upload-pack.
 *
 * Wants are already constrained to advertised refs. The walk includes commits,
 * trees, blobs, and annotated tag objects while enforcing one shared object
 * budget and iterative tree traversal (no attacker-controlled recursion).
 */

import type { ObjectStoreBinding } from "./types.ts";
import { getObject } from "./object-store.ts";
import { decodeCommit, decodeTree } from "./object.ts";
import {
  GitResourceLimitError,
  MAX_REACHABLE_OBJECTS,
  MAX_TAG_PEEL_DEPTH,
  MAX_TREE_DEPTH,
} from "./limits.ts";

const TREE_MODES = new Set(["040000", "40000"]);
const GITLINK_MODE = "160000";
const OID = /^[0-9a-f]{40}$/u;

interface PendingObject {
  readonly sha: string;
  readonly treeDepth: number;
  readonly tagDepth: number;
}

export interface ReachabilityLimits {
  /** May only tighten the engine-wide object cap. */
  readonly maxObjects?: number;
}

function annotatedTagTarget(content: Uint8Array): string | null {
  const text = new TextDecoder().decode(content);
  const separator = text.indexOf("\n\n");
  const header = separator === -1 ? text : text.slice(0, separator);
  for (const line of header.split("\n")) {
    if (!line.startsWith("object ")) continue;
    const sha = line.slice("object ".length).trim();
    return OID.test(sha) ? sha : null;
  }
  return null;
}

export async function collectReachableObjects(
  bucket: ObjectStoreBinding,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  limits: ReachabilityLimits = {},
): Promise<string[]> {
  const maxObjects = Math.min(
    MAX_REACHABLE_OBJECTS,
    Math.max(0, Math.floor(limits.maxObjects ?? MAX_REACHABLE_OBJECTS)),
  );
  const reachable = new Set<string>();
  const visited = new Set<string>();
  const pending: PendingObject[] = wants.map((sha) => ({
    sha,
    treeDepth: 0,
    tagDepth: 0,
  }));

  const addReachable = (sha: string): void => {
    if (reachable.has(sha)) return;
    if (reachable.size >= maxObjects) {
      throw new GitResourceLimitError(
        `reachability exceeds the ${maxObjects}-object limit`,
      );
    }
    reachable.add(sha);
  };

  while (pending.length > 0) {
    const item = pending.pop() as PendingObject;
    if (visited.has(item.sha) || haves.has(item.sha)) continue;
    visited.add(item.sha);

    const object = await getObject(bucket, item.sha);
    if (!object) {
      throw new Error(`reachable object is missing: ${item.sha}`);
    }

    addReachable(item.sha);
    if (object.type === "blob") continue;

    if (object.type === "tag") {
      if (item.tagDepth >= MAX_TAG_PEEL_DEPTH) {
        throw new GitResourceLimitError(
          `tag chain exceeds the ${MAX_TAG_PEEL_DEPTH}-object depth limit`,
        );
      }
      const target = annotatedTagTarget(object.content);
      if (!target) throw new Error("annotated tag has an invalid target");
      pending.push({
        sha: target,
        treeDepth: 0,
        tagDepth: item.tagDepth + 1,
      });
      continue;
    }

    if (object.type === "commit") {
      const commit = decodeCommit(object.content);
      pending.push({ sha: commit.tree, treeDepth: 0, tagDepth: 0 });
      for (const parent of commit.parents) {
        pending.push({ sha: parent, treeDepth: 0, tagDepth: 0 });
      }
      continue;
    }

    if (item.treeDepth > MAX_TREE_DEPTH) {
      throw new GitResourceLimitError(
        `tree depth exceeds the ${MAX_TREE_DEPTH}-level limit`,
      );
    }
    for (const entry of decodeTree(object.content)) {
      if (entry.mode === GITLINK_MODE) continue;
      pending.push({
        sha: entry.sha,
        treeDepth: TREE_MODES.has(entry.mode) ? item.treeDepth + 1 : 0,
        tagDepth: 0,
      });
    }
  }

  return [...reachable];
}
