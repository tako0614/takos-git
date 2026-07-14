/**
 * Runner resource / network / secret policy for the self-hosted Actions runner.
 *
 * Mirrors the Takosumi `RunnerProfile` network/resource/secret policy
 * (`takosumi/contract/internal-deploy-control-api.ts`) but for generic CI steps
 * living in takos-git. The Container DO enforces the resource + network shape;
 * the executor enforces secret redaction + output caps. Defaults are
 * intentionally conservative: default-deny egress, bounded CPU/memory/timeout,
 * runner-only secrets, redacted logs.
 */

export interface RunnerNetworkPolicy {
  /** `default-deny` blocks all egress; `egress-allowlist` permits `allowedHosts`. */
  readonly mode: "default-deny" | "egress-allowlist";
  readonly allowedHosts?: readonly string[];
}

export interface RunnerResourceLimits {
  readonly cpu: string;
  readonly memoryMb: number;
  /** Per-job wall-clock ceiling (minutes) when the workflow declares none. */
  readonly defaultJobTimeoutMinutes: number;
  /** Hard upper bound on any per-step `timeout-minutes`. */
  readonly maxStepTimeoutMinutes: number;
  /** Max bytes retained per step log before truncation. */
  readonly maxStepLogBytes: number;
  /** Max bytes for a single uploaded artifact. */
  readonly maxArtifactBytes: number;
}

export interface RunnerSecretPolicy {
  /** Secrets live only inside the runner sandbox for the run's lifetime. */
  readonly providerCredentials: "runner-only";
  /** Redact every known secret value from all streamed + sealed logs. */
  readonly redactLogs: boolean;
}

export interface RunnerPolicy {
  readonly network: RunnerNetworkPolicy;
  readonly resources: RunnerResourceLimits;
  readonly secrets: RunnerSecretPolicy;
  /** Max jobs a single run may have executing concurrently. */
  readonly maxConcurrentJobs: number;
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = {
  network: { mode: "default-deny" },
  resources: {
    cpu: "1",
    memoryMb: 2048,
    defaultJobTimeoutMinutes: 30,
    maxStepTimeoutMinutes: 360,
    maxStepLogBytes: 8 * 1024 * 1024,
    maxArtifactBytes: 256 * 1024 * 1024,
  },
  secrets: { providerCredentials: "runner-only", redactLogs: true },
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
