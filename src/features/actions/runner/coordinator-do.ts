/**
 * `ActionsRunCoordinator` — the thin Durable Object adapter over {@link RunCoordinator}.
 *
 * The queue consumer routes each run tick to `ACTIONS_RUN.idFromName(runId)`; this
 * DO owns the run-scoped serialized state (the DAG gate, deadlines, cancellation)
 * and drives dispatch through the per-job Container DO namespace `ACTIONS_JOB`.
 * All scheduling logic lives in `RunCoordinator` (unit-tested); this class only
 * adapts `ctx.storage`, the env bindings, and the job-dispatch transport.
 *
 * DEPLOY-ONLY: the Durable Object runtime + the `ACTIONS_JOB` container binding
 * cannot run in this environment. The class is compiled + structurally verified;
 * behavior is exercised through `RunCoordinator` unit tests.
 */

import { createDbClient, type D1Binding } from "../../../db/index.ts";
import type { ObjectStoreBinding } from "../../../git/types.ts";
import { actionsSecretKey } from "../env.ts";
import { RunCoordinator, type CoordinatorStorage } from "./coordinator.ts";
import { DEFAULT_RUNNER_POLICY } from "./policy.ts";
import type { ActionsJobDispatch, ActionsJobResult, RunTick } from "./contract.ts";
import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
} from "./cf-types.ts";

/** Env fields the coordinator DO reads (all present only when Actions is enabled). */
export interface CoordinatorEnv {
  ACTIONS_DB?: D1Binding;
  DB?: D1Binding;
  BUCKET: ObjectStoreBinding;
  R2_ACTIONS?: ObjectStoreBinding;
  ACTIONS_JOB?: DurableObjectNamespace;
  ACTIONS_RUNNER_SECRET?: string;
  ACTIONS_SECRETS_KEY?: string;
  APP_SESSION_SECRET?: string;
  APP_URL?: string;
}

/** Adapt DO storage (delete → boolean) to the coordinator's `CoordinatorStorage`. */
function storageAdapter(storage: DurableObjectStorage): CoordinatorStorage {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: async (key) => {
      await storage.delete(key);
    },
    list: (options) => storage.list(options),
    setAlarm: (scheduledTime) => storage.setAlarm(scheduledTime),
  };
}

export class ActionsRunCoordinator {
  readonly #ctx: DurableObjectState;
  readonly #env: CoordinatorEnv;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    this.#ctx = ctx;
    this.#env = env;
  }

  #coordinator(): RunCoordinator {
    const d1 = this.#env.ACTIONS_DB ?? this.#env.DB;
    if (!d1) throw new Error("ActionsRunCoordinator requires a D1 binding (ACTIONS_DB/DB)");
    return new RunCoordinator({
      db: createDbClient(d1),
      bucket: this.#env.BUCKET,
      storage: storageAdapter(this.#ctx.storage),
      policy: DEFAULT_RUNNER_POLICY,
      runnerSecret: this.#env.ACTIONS_RUNNER_SECRET ?? "",
      secretsKey: actionsSecretKey(this.#env),
      callbackBaseUrl: this.#env.APP_URL ?? "",
      dispatchJob: (input) => this.#dispatchToContainer(input),
    });
  }

  /** Send an assembled job to its per-job Container DO (fire; do not await run). */
  async #dispatchToContainer(input: ActionsJobDispatch): Promise<void> {
    const namespace = this.#env.ACTIONS_JOB;
    if (!namespace) throw new Error("ACTIONS_JOB namespace is not configured");
    const stub = namespace.get(namespace.idFromName(input.jobId));
    const response = await stub.fetch(
      new Request(`https://actions-job.internal/run/${encodeURIComponent(input.jobId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    if (!response.ok) throw new Error(`job runner rejected dispatch: ${response.status}`);
  }

  /** DO RPC surface: `/tick`, `/job-result`, `/cancel`. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const coordinator = this.#coordinator();
    try {
      if (url.pathname.endsWith("/tick") && request.method === "POST") {
        const tick = (await request.json()) as RunTick;
        await this.#ctx.blockConcurrencyWhile(() => coordinator.tick(tick.repoId, tick.runId));
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/job-result") && request.method === "POST") {
        const result = (await request.json()) as ActionsJobResult;
        await this.#ctx.blockConcurrencyWhile(() => coordinator.reportJobResult(result));
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/cancel") && request.method === "POST") {
        const tick = (await request.json()) as RunTick;
        await this.#ctx.blockConcurrencyWhile(() => coordinator.requestCancel(tick.repoId, tick.runId));
        return Response.json({ ok: true });
      }
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "coordinator_error" },
        { status: 500 },
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /** Timeout alarm: reap expired in-flight jobs, then re-tick. */
  async alarm(): Promise<void> {
    const coordinator = this.#coordinator();
    await this.#ctx.blockConcurrencyWhile(() => coordinator.alarm());
  }
}
