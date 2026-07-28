/**
 * Runner limits for the self-hosted Actions runner.
 *
 * SCOPE — this module only declares what takos-git code actually enforces:
 * scheduling concurrency, job/step timeouts (`coordinator.ts`, `step-executor.ts`)
 * and the log/artifact byte caps applied on the `/internal/actions/*` callback
 * surface (`internal-routes.ts`). Every field here has an enforcement site; a
 * field with no enforcement site does not belong in {@link RunnerPolicy}, because
 * a declared-but-unenforced limit reads as a guarantee it cannot keep.
 *
 * NOT enforced here: container egress, CPU and memory. Those live in the
 * container platform, and takos-git has no way to apply them from Worker code —
 * see {@link RUNNER_CONTAINER_REQUIREMENTS}.
 *
 * Secret redaction is unconditional (`redaction.ts`, applied by the executor on
 * every stream and sealed log), so it is not a policy knob either.
 */

/**
 * Container-platform requirements the runner image MUST be deployed with.
 *
 * These are NOT enforced by takos-git: the `[[containers]]` wrangler step that
 * attaches the runner image to the `ActionsJobRunner` Durable Object class is the
 * only layer that can apply them, and it is applied out of band (the cloudflare
 * OpenTofu provider 5.19.1 has no `containers` attribute). Until an operator
 * applies them, a `run:` step has UNRESTRICTED egress and whatever CPU/memory the
 * container platform defaults to. Treated as documentation of an operator
 * obligation, deliberately separate from the enforced {@link RunnerPolicy}.
 */
export const RUNNER_CONTAINER_REQUIREMENTS = {
  /** Required egress posture. Applied by the container platform, not by takos-git. */
  network: { mode: "default-deny" as const },
  /** Required per-instance CPU/memory. Applied by the container platform. */
  resources: { cpu: "1", memoryMb: 2048 },
} as const;

export interface RunnerResourceLimits {
  /** Per-job wall-clock ceiling (minutes) when the workflow declares none. */
  readonly defaultJobTimeoutMinutes: number;
  /** Hard upper bound on any per-step `timeout-minutes`. */
  readonly maxStepTimeoutMinutes: number;
  /** Max bytes retained per step log; further appends are dropped (truncated). */
  readonly maxStepLogBytes: number;
  /** Max bytes for a single uploaded artifact; a larger upload is rejected 413. */
  readonly maxArtifactBytes: number;
}

export interface RunnerPolicy {
  readonly resources: RunnerResourceLimits;
  /** Max jobs a single run may have executing concurrently. */
  readonly maxConcurrentJobs: number;
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = {
  resources: {
    defaultJobTimeoutMinutes: 30,
    maxStepTimeoutMinutes: 360,
    maxStepLogBytes: 8 * 1024 * 1024,
    maxArtifactBytes: 256 * 1024 * 1024,
  },
  maxConcurrentJobs: 4,
};

/** Resolve a step's effective timeout (ms), clamped to policy, from its contract. */
export function stepTimeoutMs(
  contractTimeoutMinutes: number | null,
  policy: RunnerPolicy = DEFAULT_RUNNER_POLICY,
): number {
  const requested = contractTimeoutMinutes ?? policy.resources.defaultJobTimeoutMinutes;
  const clamped = Math.min(Math.max(1, requested), policy.resources.maxStepTimeoutMinutes);
  return clamped * 60_000;
}

/** Resolve the per-job wall-clock ceiling (ms) from the workflow default. */
export function jobTimeoutMs(policy: RunnerPolicy = DEFAULT_RUNNER_POLICY): number {
  return policy.resources.defaultJobTimeoutMinutes * 60_000;
}
