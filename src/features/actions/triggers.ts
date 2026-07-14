/**
 * Trigger matching — which workflows fire for a push / manual dispatch.
 *
 * Ported near-verbatim from the Takos worker
 * (`application/services/actions/actions-trigger-filters.ts`), severed from any
 * DB/queue coupling. Pure over the engine `Workflow` model + `globMatch`.
 *
 * SECURITY (ReDoS): branch/path globs come from attacker-controlled
 * `.github/workflows/*.yml`; matching goes through the linear-time `globMatch`
 * (never a backtracking RegExp).
 */

import {
  type BranchFilter,
  globMatch,
  type Workflow,
  type WorkflowTrigger,
} from "./engine/index.ts";

/**
 * Resolve a trigger's config for `eventName`:
 * - `undefined` → the workflow does not subscribe to the event
 * - `null` → subscribes with no filters (bare `on: push`)
 * - object → subscribes with the given filter config
 */
export function getTriggerConfig<K extends keyof WorkflowTrigger>(
  workflow: Workflow,
  eventName: K,
): WorkflowTrigger[K] | null | undefined {
  const on = workflow.on;
  if (typeof on === "string") return on === eventName ? null : undefined;
  if (Array.isArray(on)) return on.includes(eventName) ? null : undefined;
  if (!on || typeof on !== "object") return undefined;
  if (!(eventName in on)) return undefined;
  const trigger = on[eventName];
  if (!trigger || typeof trigger !== "object") return null;
  return trigger;
}

export function matchesBranchAndPathFilters(
  config: BranchFilter,
  branch: string,
  changedFiles?: string[],
): boolean {
  if (!matchesBranchFilters(branch, config.branches, config["branches-ignore"])) {
    return false;
  }
  if (!matchesPathFilters(changedFiles, config.paths, config["paths-ignore"])) {
    return false;
  }
  return true;
}

export function matchesBranchFilters(
  branch: string,
  branches?: string[],
  branchesIgnore?: string[],
): boolean {
  if (
    Array.isArray(branches) &&
    branches.length > 0 &&
    !matchesAnyPattern(branch, branches)
  ) {
    return false;
  }
  if (
    Array.isArray(branchesIgnore) &&
    branchesIgnore.length > 0 &&
    matchesAnyPattern(branch, branchesIgnore)
  ) {
    return false;
  }
  return true;
}

export function matchesPathFilters(
  changedFiles: string[] | undefined,
  paths?: string[],
  pathsIgnore?: string[],
): boolean {
  if (!changedFiles || changedFiles.length === 0) {
    return (
      !(Array.isArray(paths) && paths.length > 0) &&
      !(Array.isArray(pathsIgnore) && pathsIgnore.length > 0)
    );
  }
  if (
    Array.isArray(paths) &&
    paths.length > 0 &&
    !changedFiles.some((file) => matchesAnyPattern(file, paths))
  ) {
    return false;
  }
  if (
    Array.isArray(pathsIgnore) &&
    pathsIgnore.length > 0 &&
    changedFiles.every((file) => matchesAnyPattern(file, pathsIgnore))
  ) {
    return false;
  }
  return true;
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, value));
}

/** True when the workflow subscribes to a `push` for this branch + change set. */
export function matchesPushTrigger(
  workflow: Workflow,
  branch: string,
  changedFiles: string[],
): boolean {
  const triggerConfig = getTriggerConfig(workflow, "push");
  if (triggerConfig === undefined) return false;
  if (triggerConfig === null) return true;
  const config = triggerConfig as BranchFilter;
  // A push trigger scoped purely to tags does not fire for a branch push.
  if (
    (!Array.isArray(config.branches) || config.branches.length === 0) &&
    Array.isArray(config.tags) &&
    config.tags.length > 0
  ) {
    return false;
  }
  return matchesBranchAndPathFilters(config, branch, changedFiles);
}

/** True when the workflow declares a `workflow_dispatch` trigger. */
export function hasWorkflowDispatch(on: Workflow["on"]): boolean {
  if (typeof on === "string") return on === "workflow_dispatch";
  if (Array.isArray(on)) return on.includes("workflow_dispatch");
  return on != null && typeof on === "object" && "workflow_dispatch" in on;
}

/** Collect the top-level trigger event names declared by a workflow. */
export function triggerEventNames(on: Workflow["on"]): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return [...on];
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}
