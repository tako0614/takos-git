/**
 * In-container step executor (Phase 5b) — the step loop the runner image runs.
 *
 * Consumes an {@link ActionsJobDispatch} and runs each {@link DispatchStep} in a
 * shared workspace, honoring `shell` / `working-directory` / `env` /
 * `continue-on-error` / `timeout-minutes`. `run:` steps spawn a shell; the only
 * MVP `uses:` actions are `<org>/checkout` (git checkout of the run-pinned tree)
 * and `<org>/upload-artifact`. Every other `uses:` fails the step with an explicit
 * "unsupported action" message. Logs stream through the injected sink and are
 * secret-REDACTED before they leave the process.
 *
 * The heavy I/O (process spawn, checkout HTTP, artifact HTTP, log HTTP) is
 * injected, so the loop is unit-testable with a real shell + mocked internal
 * HTTP. `executor-main.ts` wires the production implementations.
 */

import type {
  ActionsJobDispatch,
  DispatchStep,
  StepResultReport,
} from "../../../src/features/actions/runner/contract.ts";
import type { RunConclusion } from "../../../src/features/actions/dto.ts";
import { createRedactor } from "../../../src/features/actions/runner/redaction.ts";
import { stepTimeoutMs, DEFAULT_RUNNER_POLICY } from "../../../src/features/actions/runner/policy.ts";

export interface CommandResult {
  /** Process exit code, or null when killed (e.g. on timeout). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface SpawnOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  /** Merged stdout+stderr, streamed as decoded text (already un-redacted). */
  onOutput(chunk: string): void;
}

export type SpawnFn = (options: SpawnOptions) => Promise<CommandResult>;

export interface CheckoutClient {
  /** Materialize the run-pinned tree into `dest`. */
  checkout(dest: string): Promise<void>;
}

export interface ArtifactClient {
  /** Upload the file/dir at `sourcePath` under `name`. */
  upload(name: string, sourcePath: string): Promise<void>;
}

export interface LogSink {
  /** Append already-redacted text to the job (optionally step-scoped) log. */
  append(text: string, stepId?: string): Promise<void>;
}

export interface ExecuteJobDeps {
  readonly spawn: SpawnFn;
  readonly checkout: CheckoutClient;
  readonly artifacts: ArtifactClient;
  readonly logs: LogSink;
  readonly workspaceDir: string;
  /** Base process env (PATH/HOME/…) the container ships. */
  readonly baseEnv?: Record<string, string>;
  readonly defaultShell?: string;
  readonly now?: () => number;
  /** Optional live step-status hook (executor-main POSTs it; tests may omit). */
  onStepStatus?(stepId: string, status: "in_progress" | "completed", conclusion?: RunConclusion): Promise<void>;
}

export interface JobExecution {
  readonly conclusion: RunConclusion;
  readonly steps: StepResultReport[];
}

const CHECKOUT_ACTION = /(^|\/)checkout(@|$)/u;
const UPLOAD_ARTIFACT_ACTION = /(^|\/)upload-artifact(@|$)/u;

function joinPath(base: string, sub: string | null): string {
  if (!sub) return base;
  const clean = sub.replace(/^\/+/u, "");
  return clean ? `${base.replace(/\/+$/u, "")}/${clean}` : base;
}

/** Build the argv for a `run:` step's shell (GitHub-shaped defaults). */
export function shellArgv(shell: string | null, defaultShell: string, script: string): string[] {
  const resolved = (shell ?? defaultShell).trim().toLowerCase();
  switch (resolved) {
    case "":
    case "bash":
      return ["bash", "-e", "-o", "pipefail", "-c", script];
    case "sh":
      return ["sh", "-e", "-c", script];
    case "python":
    case "python3":
      return ["python3", "-c", script];
    default:
      // Best-effort: run an arbitrary interpreter as `<shell> -c <script>`.
      return [resolved, "-c", script];
  }
}

/** Run every step of a job; returns the per-step reports + the job verdict. */
export async function executeJob(
  dispatch: ActionsJobDispatch,
  deps: ExecuteJobDeps,
): Promise<JobExecution> {
  const now = deps.now ?? (() => Date.now());
  const defaultShell = deps.defaultShell ?? "bash";
  const redact = createRedactor(dispatch.secrets.map((secret) => secret.value));
  const secretEnv: Record<string, string> = {};
  for (const secret of dispatch.secrets) secretEnv[secret.name] = secret.value;

  const log = async (text: string, stepId?: string): Promise<void> => {
    await deps.logs.append(redact(text), stepId);
  };

  const reports: StepResultReport[] = [];
  let jobFailed = false;
  let jobConclusion: RunConclusion = "success";

  for (const step of dispatch.steps) {
    const startedAt = now();
    if (jobFailed) {
      // A prior hard failure short-circuits the rest (no `if:` evaluation in MVP).
      reports.push(skippedReport(step, startedAt, now()));
      continue;
    }
    await deps.onStepStatus?.(step.stepId, "in_progress");
    await log(`\n=== ${step.contract.name} ===\n`, step.stepId);

    const outcome = await runStep(dispatch, step, {
      ...deps,
      now,
      defaultShell,
      secretEnv,
      redact,
      log,
    });

    const completedAt = now();
    const continueOnError = step.contract["continue-on-error"] === true;
    let conclusion = outcome.conclusion;
    if (conclusion !== "success" && continueOnError) {
      await log(`(continue-on-error) step failed but the job continues\n`, step.stepId);
    } else if (conclusion !== "success") {
      jobFailed = true;
      jobConclusion = conclusion;
    }
    reports.push({
      stepId: step.stepId,
      number: step.number,
      conclusion,
      exitCode: outcome.exitCode,
      startedAt,
      completedAt,
      errorMessage: outcome.errorMessage ?? null,
    });
    await deps.onStepStatus?.(step.stepId, "completed", conclusion);
  }

  return { conclusion: jobFailed ? jobConclusion : "success", steps: reports };
}

function skippedReport(step: DispatchStep, startedAt: number, completedAt: number): StepResultReport {
  return {
    stepId: step.stepId,
    number: step.number,
    conclusion: "skipped",
    exitCode: null,
    startedAt,
    completedAt,
  };
}

interface StepRunDeps extends ExecuteJobDeps {
  readonly now: () => number;
  readonly defaultShell: string;
  readonly secretEnv: Record<string, string>;
  readonly redact: (text: string) => string;
  readonly log: (text: string, stepId?: string) => Promise<void>;
}

interface StepOutcome {
  readonly conclusion: RunConclusion;
  readonly exitCode: number | null;
  readonly errorMessage?: string;
}

async function runStep(
  dispatch: ActionsJobDispatch,
  step: DispatchStep,
  deps: StepRunDeps,
): Promise<StepOutcome> {
  const { contract } = step;
  const uses = contract.uses?.trim() ?? null;

  if (uses) {
    if (CHECKOUT_ACTION.test(uses)) {
      try {
        await deps.checkout.checkout(deps.workspaceDir);
        await deps.log(`checked out ${dispatch.checkout.commit}\n`, step.stepId);
        return { conclusion: "success", exitCode: 0 };
      } catch (error) {
        await deps.log(`checkout failed: ${errText(error)}\n`, step.stepId);
        return { conclusion: "failure", exitCode: null, errorMessage: errText(error) };
      }
    }
    if (UPLOAD_ARTIFACT_ACTION.test(uses)) {
      return uploadArtifactStep(step, deps);
    }
    const message = `unsupported action: ${uses} (MVP supports checkout + upload-artifact; use run: for everything else)`;
    await deps.log(`${message}\n`, step.stepId);
    return { conclusion: "failure", exitCode: null, errorMessage: message };
  }

  const script = contract.run;
  if (script === null || script.trim().length === 0) {
    return { conclusion: "success", exitCode: 0 }; // nothing to run
  }
  return runShellStep(dispatch, step, deps, script);
}

async function uploadArtifactStep(step: DispatchStep, deps: StepRunDeps): Promise<StepOutcome> {
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

async function runShellStep(
  dispatch: ActionsJobDispatch,
  step: DispatchStep,
  deps: StepRunDeps,
  script: string,
): Promise<StepOutcome> {
  const { contract } = step;
  const cwd = joinPath(deps.workspaceDir, contract["working-directory"]);
  // Precedence: base env < injected secrets < step's merged contract env.
  const env: Record<string, string> = {
    ...(deps.baseEnv ?? {}),
    ...deps.secretEnv,
    ...contract.env,
    GITHUB_WORKSPACE: deps.workspaceDir,
  };
  const argv = shellArgv(contract.shell, deps.defaultShell, script);
  const timeoutMs = stepTimeoutMs(contract["timeout-minutes"], DEFAULT_RUNNER_POLICY);

  const result = await deps.spawn({
    argv,
    cwd,
    env,
    timeoutMs,
    onOutput: (chunk) => {
      // Fire-and-forget log streaming; redaction happens inside `log`.
      void deps.log(chunk, step.stepId);
    },
  });

  if (result.timedOut) {
    await deps.log(`step timed out after ${Math.round(timeoutMs / 1000)}s\n`, step.stepId);
    return { conclusion: "timed_out", exitCode: result.exitCode, errorMessage: "step timed out" };
  }
  if (result.exitCode === 0) return { conclusion: "success", exitCode: 0 };
  return {
    conclusion: "failure",
    exitCode: result.exitCode,
    errorMessage: `step exited with code ${result.exitCode}`,
  };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
