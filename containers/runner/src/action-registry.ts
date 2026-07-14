/**
 * Capability registry for in-container `uses:` actions.
 *
 * The step loop ({@link executeJob}) delegates every `uses:` step to a handler
 * looked up here by *normalized action name* (the last path segment, version
 * suffix stripped, lower-cased) — so `actions/checkout@v4`, `takos/checkout`,
 * and `checkout` all resolve to the same `checkout` handler. Adding an action
 * later is a one-line {@link registerAction} call; genuinely-unsupported actions
 * resolve to `null` and the loop fails the step with an explicit message.
 *
 * Supported today: `checkout`, `upload-artifact`, `download-artifact`.
 * Documented follow-ups (NOT implemented): `cache`, `setup-*` (setup-node /
 * setup-python / …) — each would register here as one more handler.
 *
 * Handlers receive an {@link ActionContext} (dispatch + step + the same injected
 * step deps the shell path uses) and return a {@link StepOutcome}. They perform
 * no process spawning of their own; the heavy I/O (checkout HTTP, artifact HTTP)
 * is behind the injected clients, keeping this module unit-testable.
 */

import type { ActionsJobDispatch, DispatchStep } from "../../../src/features/actions/runner/contract.ts";
import { joinPath, errText, type StepOutcome, type StepRunDeps } from "./step-executor.ts";

/** Everything a `uses:` handler needs, mirroring the shell path's inputs. */
export interface ActionContext {
  readonly dispatch: ActionsJobDispatch;
  readonly step: DispatchStep;
  readonly deps: StepRunDeps;
}

/** A `uses:` action implementation. Pure w.r.t. process spawning (I/O injected). */
export type ActionHandler = (ctx: ActionContext) => Promise<StepOutcome>;

const REGISTRY = new Map<string, ActionHandler>();

/**
 * Normalize a `uses:` reference to its lookup key: the last `/`-segment of the
 * ref with any `@version` suffix removed, lower-cased. Returns `""` for a ref
 * that has no usable segment.
 */
export function normalizeActionName(uses: string): string {
  const withoutVersion = uses.split("@", 1)[0]!.trim();
  const segments = withoutVersion.split("/").filter((segment) => segment.length > 0);
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

/** Register (or override) the handler for a normalized action name. */
export function registerAction(name: string, handler: ActionHandler): void {
  REGISTRY.set(name.toLowerCase(), handler);
}

/** Resolve a `uses:` reference to its handler, or `null` when unsupported. */
export function resolveAction(uses: string): ActionHandler | null {
  return REGISTRY.get(normalizeActionName(uses)) ?? null;
}

/** The sorted list of supported action names (for the unsupported-action message). */
export function supportedActionNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

// ── Built-in handlers ───────────────────────────────────────────────────────

/** `<org>/checkout` — materialize the run-pinned tree into the workspace. */
async function checkoutStep({ dispatch, step, deps }: ActionContext): Promise<StepOutcome> {
  try {
    await deps.checkout.checkout(deps.workspaceDir);
    await deps.log(`checked out ${dispatch.checkout.commit}\n`, step.stepId);
    return { conclusion: "success", exitCode: 0 };
  } catch (error) {
    await deps.log(`checkout failed: ${errText(error)}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: errText(error) };
  }
}

/** `<org>/upload-artifact` — store the file/dir at `with.path` under `with.name`. */
async function uploadArtifactStep({ step, deps }: ActionContext): Promise<StepOutcome> {
  const withInputs = step.contract.with ?? {};
  const path = typeof withInputs.path === "string" ? withInputs.path : null;
  const name = typeof withInputs.name === "string" ? withInputs.name : "artifact";
  if (!path) {
    const message = "upload-artifact requires a `with.path` input";
    await deps.log(`${message}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: message };
  }
  try {
    await deps.artifacts.upload(name, joinPath(deps.workspaceDir, path));
    await deps.log(`uploaded artifact "${name}" from ${path}\n`, step.stepId);
    return { conclusion: "success", exitCode: 0 };
  } catch (error) {
    await deps.log(`artifact upload failed: ${errText(error)}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: errText(error) };
  }
}

/**
 * `<org>/download-artifact` — fetch the artifact named `with.name` from the
 * run's internal artifacts route and unpack it into `with.path` (default: the
 * workspace root). `with.name` is required; there is no "download every
 * artifact" mode in this MVP.
 */
async function downloadArtifactStep({ step, deps }: ActionContext): Promise<StepOutcome> {
  const withInputs = step.contract.with ?? {};
  const name = typeof withInputs.name === "string" ? withInputs.name : null;
  const path = typeof withInputs.path === "string" ? withInputs.path : null;
  if (!name) {
    const message = "download-artifact requires a `with.name` input";
    await deps.log(`${message}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: message };
  }
  try {
    await deps.artifacts.download(name, joinPath(deps.workspaceDir, path));
    await deps.log(`downloaded artifact "${name}" to ${path ?? "."}\n`, step.stepId);
    return { conclusion: "success", exitCode: 0 };
  } catch (error) {
    await deps.log(`artifact download failed: ${errText(error)}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: errText(error) };
  }
}

registerAction("checkout", checkoutStep);
registerAction("upload-artifact", uploadArtifactStep);
registerAction("download-artifact", downloadArtifactStep);
