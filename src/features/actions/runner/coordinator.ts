/**
 * Run coordinator CORE (Phase 5b) — the run-scoped scheduler.
 *
 * Owns, per run: the `needs:` DAG gate, skip-propagation, a per-run concurrency
 * budget, per-job timeout deadlines, cancellation, and idempotent dispatch. It
 * reads the persisted `workflow_jobs` / `workflow_steps` rows the 5a control
 * plane wrote and drives state ONLY through the exported 5a callbacks
 * (`startRun` / `startJob` / `updateStep` / `completeJob` / `cancelRun`), so this
 * layer never invents a second status source of truth.
 *
 * This module is deliberately runtime-free: it takes an injected {@link CoordinatorStorage}
 * (the DO's `ctx.storage` in production, a fake in tests) and an injected
 * `dispatchJob`, so the scheduling logic is unit-testable without a Durable
 * Object or a Container. `ActionsRunCoordinator` (`./coordinator-do.ts`) is the
 * thin DO adapter around it.
 *
 * Idempotency: safe under queue re-delivery. `startRun`/`startJob`/`completeJob`
 * are guarded transitions; a `dispatched:<jobId>` storage marker prevents a
 * re-tick from double-dispatching an in-flight job.
 */

import type { DbClient } from "../../../db/index.ts";
import type { ObjectStoreBinding } from "../../../git/types.ts";
import { pinRunCommit, runPinRefName, unpinRun } from "../../../git/refs-store.ts";
import type { RunConclusion } from "../dto.ts";
import { decryptWorkflowSecret } from "../secrets.ts";
import {
  cancelRun,
  completeJob,
  finalizeRunIfComplete,
  startJob,
  startRun,
  updateStep,
} from "../service.ts";
import { jobTimeoutMs, DEFAULT_RUNNER_POLICY, type RunnerPolicy } from "./policy.ts";
import { mintRunnerToken } from "./hmac.ts";
import {
  ACTIONS_JOB_KIND,
  type ActionsJobDispatch,
  type ActionsJobResult,
  type DispatchSecret,
  type DispatchStep,
} from "./contract.ts";

// A verdict rank so a matrix job's aggregate conclusion is its worst cell.
const RANK: Record<RunConclusion, number> = {
  skipped: 0,
  success: 1,
  cancelled: 2,
  timed_out: 3,
  failure: 4,
};

/** Narrow view of a Durable Object's storage the coordinator needs. */
export interface CoordinatorStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface CoordinatorDeps {
  readonly db: DbClient;
  readonly bucket: ObjectStoreBinding;
  readonly storage: CoordinatorStorage;
  readonly policy?: RunnerPolicy;
  readonly runnerSecret: string;
  /** Key material for just-in-time secret decryption (may be null → no secrets). */
  readonly secretsKey: string | null;
  /** Absolute base URL the container calls back on (`https://…`). */
  readonly callbackBaseUrl: string;
  readonly now?: () => number;
  /** Deliver one assembled job to the per-job Container DO. */
  dispatchJob(input: ActionsJobDispatch): Promise<void>;
}

interface JobRow {
  id: string;
  job_key: string | null;
  name: string;
  matrix: string | null;
  needs: string | null;
  status: string;
  conclusion: string | null;
}

interface RunRow {
  id: string;
  repo_id: string;
  sha: string | null;
  status: string;
}

interface KeyState {
  readonly settled: boolean;
  readonly conclusion: RunConclusion | null;
}

const META_KEY = "meta";
const CANCEL_KEY = "cancelled";

/** The run-scoped scheduler. One instance per `(repoId, runId)`. */
export class RunCoordinator {
  readonly #db: DbClient;
  readonly #bucket: ObjectStoreBinding;
  readonly #storage: CoordinatorStorage;
  readonly #policy: RunnerPolicy;
  readonly #runnerSecret: string;
  readonly #secretsKey: string | null;
  readonly #callbackBaseUrl: string;
  readonly #now: () => number;
  readonly #dispatchJob: (input: ActionsJobDispatch) => Promise<void>;

  constructor(deps: CoordinatorDeps) {
    this.#db = deps.db;
    this.#bucket = deps.bucket;
    this.#storage = deps.storage;
    this.#policy = deps.policy ?? DEFAULT_RUNNER_POLICY;
    this.#runnerSecret = deps.runnerSecret;
    this.#secretsKey = deps.secretsKey;
    this.#callbackBaseUrl = deps.callbackBaseUrl.replace(/\/+$/u, "");
    this.#now = deps.now ?? (() => Date.now());
    this.#dispatchJob = deps.dispatchJob;
  }

  /** Repo storage key (`owner/name`) for the run, needed for R2 checkout + pin. */
  async #repoStorageKey(repoId: string): Promise<string | null> {
    const row = await this.#db.queryOne<{ owner_login: string; name: string }>(
      `SELECT o.login AS owner_login, r.name AS name
         FROM repositories r JOIN owners o ON o.id = r.owner_id
        WHERE r.id = ? LIMIT 1`,
      [repoId],
    );
    return row ? `${row.owner_login}/${row.name}` : null;
  }

  async #run(repoId: string, runId: string): Promise<RunRow | null> {
    return this.#db.queryOne<RunRow>(
      `SELECT id, repo_id, sha, status FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
      [runId, repoId],
    );
  }

  async #jobs(runId: string): Promise<JobRow[]> {
    return this.#db.query<JobRow>(
      `SELECT id, job_key, name, matrix, needs, status, conclusion
         FROM workflow_jobs WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
      [runId],
    );
  }

  /**
   * Evaluate the DAG and dispatch every READY job (up to the concurrency budget).
   * Idempotent: safe to call repeatedly (queue re-delivery, post-completion waves).
   */
  async tick(repoId: string, runId: string): Promise<void> {
    const run = await this.#run(repoId, runId);
    if (!run || run.status === "completed") return;

    if (await this.#storage.get<boolean>(CANCEL_KEY)) {
      await cancelRun(this.#db, repoId, runId);
      await this.#cleanupRun(repoId, runId);
      return;
    }

    await this.#storage.put(META_KEY, { repoId, runId });
    await startRun(this.#db, repoId, runId);

    // Fixpoint pass: a skip settles a jobKey, which can transitively skip its
    // dependents, so re-evaluate until a full pass produces no new skip. Dispatch
    // moves a job to in_progress (not settled), so it never cascades within a tick.
    for (let guard = 0; guard < 1000; guard += 1) {
      const jobs = await this.#jobs(runId);
      const keyStates = computeKeyStates(jobs);
      const inFlight = jobs.filter((job) => job.status === "in_progress").length;
      let budget = Math.max(0, this.#policy.maxConcurrentJobs - inFlight);
      let skippedAny = false;

      for (const job of jobs) {
        if (job.status !== "queued") continue;
        const decision = evaluateNeeds(parseNeeds(job.needs), keyStates);
        if (decision === "waiting") continue;
        if (decision === "skip") {
          await this.#skipJob(repoId, job);
          skippedAny = true;
          continue;
        }
        if (budget <= 0) continue;
        if (await this.#storage.get<boolean>(`dispatched:${job.id}`)) continue;
        await this.#dispatchOne(repoId, run, job);
        budget -= 1;
      }
      if (!skippedAny) break;
    }

    // A wave of skips may have made every job terminal — finalize (idempotent).
    await finalizeRunIfComplete(this.#db, repoId, runId);
    await this.#maybeCleanup(repoId, runId);
  }

  /** Mark a job skipped (its `needs` did not all succeed) + skip its steps. */
  async #skipJob(repoId: string, job: JobRow): Promise<void> {
    const stepIds = await this.#db.query<{ id: string }>(
      `SELECT id FROM workflow_steps WHERE job_id = ? AND status != 'completed'`,
      [job.id],
    );
    for (const step of stepIds) {
      await updateStep(this.#db, step.id, {
        status: "completed",
        conclusion: "skipped",
        completedAt: this.#now(),
      });
    }
    await completeJob(this.#db, repoId, job.id, { conclusion: "skipped" });
    await this.#storage.put(`dispatched:${job.id}`, true);
  }

  /** Assemble and dispatch one ready job to its Container DO. */
  async #dispatchOne(repoId: string, run: RunRow, job: JobRow): Promise<void> {
    const repoKey = await this.#repoStorageKey(repoId);
    if (!repoKey || !run.sha) {
      // No resolvable checkout coordinate — fail the job rather than hang.
      await completeJob(this.#db, repoId, job.id, { conclusion: "failure" });
      await this.#storage.put(`dispatched:${job.id}`, true);
      return;
    }

    // Pin the run's commit so a concurrent force-push cannot move what it builds.
    await pinRunCommit(this.#bucket, repoKey, run.id, run.sha);

    const steps = await this.#loadSteps(job.id);
    const secrets = await this.#loadSecrets(repoId);
    const timeout = jobTimeoutMs(this.#policy);
    const now = this.#now();
    const token = await mintRunnerToken(this.#runnerSecret, { runId: run.id, jobId: job.id }, now);

    const dispatch: ActionsJobDispatch = {
      kind: ACTIONS_JOB_KIND,
      runId: run.id,
      jobId: job.id,
      repoId,
      repo: repoKey,
      attempt: 1,
      checkout: { commit: run.sha, ref: runPinRefName(run.id) },
      job: { matrix: parseJson<Record<string, unknown>>(job.matrix) },
      secrets,
      steps,
      timeoutMs: timeout,
      callbackBaseUrl: this.#callbackBaseUrl,
      callbackToken: token,
    };

    // Mark in-flight + schedule the timeout backstop BEFORE dispatch so a lost
    // dispatch is still reaped by the alarm and never double-dispatched.
    await startJob(this.#db, repoId, job.id, `takos-git-runner/${job.id.slice(0, 8)}`);
    await this.#storage.put(`dispatched:${job.id}`, true);
    await this.#storage.put(`deadline:${job.id}`, now + timeout);
    await this.#storage.setAlarm(now + timeout);

    try {
      await this.#dispatchJob(dispatch);
    } catch {
      // Best-effort: the deadline alarm reaps a job whose dispatch never landed.
    }
  }

  async #loadSteps(jobId: string): Promise<DispatchStep[]> {
    const rows = await this.#db.query<{ id: string; number: number; exec_contract: string }>(
      `SELECT id, number, exec_contract FROM workflow_steps WHERE job_id = ? ORDER BY number ASC`,
      [jobId],
    );
    return rows.flatMap((row) => {
      const contract = parseJson<DispatchStep["contract"]>(row.exec_contract);
      if (!contract) return [];
      return [{ stepId: row.id, number: row.number, contract }];
    });
  }

  async #loadSecrets(repoId: string): Promise<DispatchSecret[]> {
    if (!this.#secretsKey) return [];
    const names = await this.#db.query<{ name: string }>(
      `SELECT name FROM workflow_secrets WHERE repo_id = ?`,
      [repoId],
    );
    const out: DispatchSecret[] = [];
    for (const { name } of names) {
      const value = await decryptWorkflowSecret(this.#db, repoId, name, this.#secretsKey);
      if (value !== null) out.push({ name, value });
    }
    return out;
  }

  /**
   * Record a container's job result: per-step status, then the job verdict (which
   * projects the check-run / commit-status and finalizes the run when every job
   * is terminal), then schedule the next dispatch wave.
   */
  async reportJobResult(result: ActionsJobResult): Promise<void> {
    const meta = await this.#storage.get<{ repoId: string; runId: string }>(META_KEY);
    const repoId = meta?.repoId;
    if (!repoId) return; // tick always runs first; without meta there is nothing to scope.

    for (const step of result.steps) {
      await updateStep(this.#db, step.stepId, {
        status: "completed",
        conclusion: step.conclusion,
        exitCode: step.exitCode,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        errorMessage: step.errorMessage ?? null,
      });
    }
    await completeJob(this.#db, repoId, result.jobId, {
      conclusion: result.conclusion,
      logsR2Key: result.logsR2Key,
    });
    await this.#storage.delete(`deadline:${result.jobId}`);
    // Dispatch anything the just-finished job unblocked.
    await this.tick(repoId, result.runId);
  }

  /** Request cancellation. The next tick (or this call) tears the run down. */
  async requestCancel(repoId: string, runId: string): Promise<void> {
    await this.#storage.put(CANCEL_KEY, true);
    await cancelRun(this.#db, repoId, runId);
    await this.#cleanupRun(repoId, runId);
  }

  /** Alarm: reap any in-flight job whose deadline elapsed, then re-tick. */
  async alarm(): Promise<void> {
    const meta = await this.#storage.get<{ repoId: string; runId: string }>(META_KEY);
    if (!meta) return;
    const now = this.#now();
    const deadlines = await this.#storage.list<number>({ prefix: "deadline:" });
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const [key, deadline] of deadlines) {
      const jobId = key.slice("deadline:".length);
      if (deadline <= now) {
        await this.#timeOutJob(meta.repoId, jobId);
        await this.#storage.delete(key);
      } else {
        nextDeadline = Math.min(nextDeadline, deadline);
      }
    }
    await this.tick(meta.repoId, meta.runId);
    if (Number.isFinite(nextDeadline)) await this.#storage.setAlarm(nextDeadline);
  }

  async #timeOutJob(repoId: string, jobId: string): Promise<void> {
    const steps = await this.#db.query<{ id: string }>(
      `SELECT id FROM workflow_steps WHERE job_id = ? AND status != 'completed'`,
      [jobId],
    );
    for (const step of steps) {
      await updateStep(this.#db, step.id, {
        status: "completed",
        conclusion: "timed_out",
        completedAt: this.#now(),
      });
    }
    await completeJob(this.#db, repoId, jobId, { conclusion: "timed_out" });
  }

  async #maybeCleanup(repoId: string, runId: string): Promise<void> {
    const run = await this.#run(repoId, runId);
    if (run?.status === "completed") await this.#cleanupRun(repoId, runId);
  }

  /** Drop the run pin + coordinator scratch once the run is terminal. */
  async #cleanupRun(repoId: string, runId: string): Promise<void> {
    const repoKey = await this.#repoStorageKey(repoId);
    if (repoKey) await unpinRun(this.#bucket, repoKey, runId).catch(() => undefined);
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────

export function parseNeeds(value: string | null): string[] {
  const parsed = parseJson<unknown>(value);
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  return [];
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Aggregate per-jobKey settle state + worst-cell conclusion (matrix-aware). */
export function computeKeyStates(jobs: readonly JobRow[]): Map<string, KeyState> {
  const groups = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const key = job.job_key ?? job.id;
    const list = groups.get(key);
    if (list) list.push(job);
    else groups.set(key, [job]);
  }
  const states = new Map<string, KeyState>();
  for (const [key, rows] of groups) {
    const settled = rows.every((row) => row.status === "completed");
    let conclusion: RunConclusion | null = null;
    if (settled) {
      let worst: RunConclusion = "skipped";
      for (const row of rows) {
        const c = (row.conclusion as RunConclusion | null) ?? "failure";
        if (RANK[c] >= RANK[worst]) worst = c;
      }
      conclusion = worst;
    }
    states.set(key, { settled, conclusion });
  }
  return states;
}

export type NeedsDecision = "ready" | "waiting" | "skip";

/**
 * GitHub-default `needs` gating: a job is READY only when every prerequisite
 * jobKey settled `success`; a settled non-success prerequisite (failure,
 * cancelled, timed_out, or skipped) SKIPS the dependent; an unsettled
 * prerequisite means WAIT.
 */
export function evaluateNeeds(
  needs: readonly string[],
  keyStates: ReadonlyMap<string, KeyState>,
): NeedsDecision {
  if (needs.length === 0) return "ready";
  let allSuccess = true;
  for (const need of needs) {
    const state = keyStates.get(need);
    if (!state || !state.settled) return "waiting";
    if (state.conclusion !== "success") allSuccess = false;
  }
  return allSuccess ? "ready" : "skip";
}
