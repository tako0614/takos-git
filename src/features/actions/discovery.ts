/**
 * Workflow discovery over R2 git objects.
 *
 * Reads `.github/workflows/*.yml|*.yaml` from a repo tree at a given commit,
 * parses + validates each with the ported engine, and returns the well-formed
 * candidates. Also computes the changed-file set between two commits so push
 * `paths:` / `paths-ignore:` filters can be evaluated.
 *
 * R2 stays authoritative for git objects: this module only READS objects (through
 * the repo-scoped {@link ObjectStoreBinding}); it never writes git data and never
 * treats a D1 row as a source of truth for a SHA.
 *
 * Ported from the Takos worker
 * (`actions-trigger-workflow-loader.ts` + `actions-triggers.computePushChangedFiles`),
 * repointed onto `src/git` and the workflow path `.github/workflows` (GitHub
 * parity; the legacy Takos path was `.takos/workflows`).
 */

import { getCommitData } from "../../git/object-store.ts";
import { flattenTree, getBlobAtPath, listDirectory } from "../../git/tree-ops.ts";
import { FILE_MODES } from "../../git/git-objects.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import {
  parseWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowDiagnostic,
} from "./engine/index.ts";

/** The repo-relative directory workflows live in (GitHub parity). */
export const WORKFLOWS_DIR = ".github/workflows";

export interface WorkflowCandidate {
  readonly path: string;
  readonly name: string | null;
  /** Blob SHA of the workflow file in R2 (advisory; the file stays authoritative). */
  readonly contentSha: string;
  readonly workflow: Workflow;
}

export type WorkflowLoadResult =
  | { readonly ok: true; readonly workflow: Workflow }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details: string[];
    };

function errors(diagnostics: WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

/**
 * Parse + validate a single workflow YAML body. Both a parse error and a schema
 * validation error fail closed with the offending messages.
 */
export function loadAndValidateWorkflow(content: string): WorkflowLoadResult {
  let parsed: ReturnType<typeof parseWorkflow>;
  try {
    parsed = parseWorkflow(content);
  } catch (error) {
    return {
      ok: false,
      message: "Workflow parse error",
      details: [error instanceof Error ? error.message : String(error)],
    };
  }
  const parseErrors = errors(parsed.diagnostics);
  if (parseErrors.length > 0) {
    return {
      ok: false,
      message: "Workflow parse error",
      details: parseErrors.map((e) => e.message),
    };
  }
  const validation = validateWorkflow(parsed.workflow);
  const validationErrors = errors(validation.diagnostics);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      message: "Workflow validation error",
      details: validationErrors.map((e) => e.message),
    };
  }
  return { ok: true, workflow: parsed.workflow };
}

/**
 * List `.github/workflows/*.yml|*.yaml` entries in the tree at `commitSha`.
 * Returns `{ path, sha }` pairs (blob SHAs), or `[]` when the directory is absent.
 */
export async function listWorkflowFiles(
  objects: ObjectStoreBinding,
  commitSha: string,
): Promise<Array<{ path: string; sha: string }>> {
  const commit = await getCommitData(objects, commitSha);
  if (!commit) return [];
  const entries = await listDirectory(objects, commit.tree, WORKFLOWS_DIR);
  if (!entries) return [];
  return entries
    .filter((entry) => {
      if (entry.mode === FILE_MODES.DIRECTORY) return false;
      const lower = entry.name.toLowerCase();
      return lower.endsWith(".yml") || lower.endsWith(".yaml");
    })
    .map((entry) => ({ path: `${WORKFLOWS_DIR}/${entry.name}`, sha: entry.sha }));
}

/**
 * Discover every well-formed workflow at `commitSha`. Malformed files (parse or
 * validation errors) are skipped so one broken workflow never blocks the rest —
 * the same tolerance the Takos loader had.
 */
export async function discoverWorkflows(
  objects: ObjectStoreBinding,
  commitSha: string,
): Promise<WorkflowCandidate[]> {
  const commit = await getCommitData(objects, commitSha);
  if (!commit) return [];
  const entries = await listDirectory(objects, commit.tree, WORKFLOWS_DIR);
  if (!entries) return [];
  const candidates: WorkflowCandidate[] = [];
  for (const entry of entries) {
    if (entry.mode === FILE_MODES.DIRECTORY) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".yml") && !lower.endsWith(".yaml")) continue;
    const path = `${WORKFLOWS_DIR}/${entry.name}`;
    const blob = await getBlobAtPath(objects, commit.tree, path);
    if (!blob) continue;
    const content = new TextDecoder().decode(blob);
    const result = loadAndValidateWorkflow(content);
    if (!result.ok) continue;
    candidates.push({
      path,
      name: result.workflow.name ?? null,
      contentSha: entry.sha,
      workflow: result.workflow,
    });
  }
  return candidates;
}

/**
 * Compute the set of changed file paths between `beforeSha` and `afterSha` by
 * diffing the two flattened trees. A null `beforeSha` (branch creation) yields the
 * full file list. Ported from `actions-triggers.computePushChangedFiles`.
 */
export async function computeChangedFiles(
  objects: ObjectStoreBinding,
  afterSha: string,
  beforeSha: string | null,
): Promise<string[]> {
  const afterCommit = await getCommitData(objects, afterSha);
  if (!afterCommit) return [];
  const afterFiles = await flattenTree(objects, afterCommit.tree, "", {
    skipSymlinks: true,
  });
  if (!beforeSha) {
    return afterFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
  }
  const beforeCommit = await getCommitData(objects, beforeSha);
  if (!beforeCommit) {
    return afterFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
  }
  const beforeFiles = await flattenTree(objects, beforeCommit.tree, "", {
    skipSymlinks: true,
  });
  const beforeMap = new Map(beforeFiles.map((file) => [file.path, file.sha]));
  const afterMap = new Map(afterFiles.map((file) => [file.path, file.sha]));
  const changed = new Set<string>();
  for (const [path, sha] of afterMap) {
    if (beforeMap.get(path) !== sha) changed.add(path);
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) changed.add(path);
  }
  return Array.from(changed).sort((a, b) => a.localeCompare(b));
}
