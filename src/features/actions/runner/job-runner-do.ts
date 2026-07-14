/**
 * `ActionsJobRunner` — the per-job Container Durable Object.
 *
 * Starts (or reuses) the runner Container, forwards the assembled
 * {@link ActionsJobDispatch} to the in-container step server, relays the
 * {@link ActionsJobResult} back to the run coordinator, and enforces the per-job
 * timeout + a cancellation signal. One DO instance per `jobId`
 * (`ACTIONS_JOB.idFromName(jobId)`).
 *
 * DEPLOY-ONLY: the Cloudflare Container runtime cannot run in this environment.
 * The `@cloudflare/containers` base is loaded at runtime (via a specifier the
 * bundler cannot see) with a local stub fallback, so the worker bundle builds and
 * typechecks without the package; when Containers are not configured the DO
 * returns 501 and reports the job as failed. Enabling real execution requires
 * adding `@cloudflare/containers` + a wrangler `[[containers]]` image binding
 * (see `main.tf` / the docs — the cloudflare TF provider cannot express it).
 */

import type { RunConclusion } from "../dto.ts";
import type { ActionsJobDispatch, ActionsJobResult } from "./contract.ts";
import type { ContainerRuntime, DurableObjectNamespace, DurableObjectState } from "./cf-types.ts";

const CONTAINER_PORT = 8080;
const CONTAINER_ENTRYPOINT = ["/app/containers/runner/start.sh"];

/** Env fields the job-runner DO reads. */
export interface JobRunnerEnv {
  ACTIONS_RUN?: DurableObjectNamespace;
}

/** Local fallback when the Cloudflare Containers runtime is unavailable. */
class LocalContainerRuntime {
  readonly ctx: unknown;
  readonly env: unknown;
  defaultPort = CONTAINER_PORT;
  envVars: Record<string, string> = {};
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
  containerFetch(_request: Request, _port?: number): Promise<Response> {
    return Promise.reject(new Error("Cloudflare Containers runtime is unavailable in this environment"));
  }
  startAndWaitForPorts(): Promise<void> {
    return Promise.reject(new Error("Cloudflare Containers runtime is unavailable in this environment"));
  }
}

async function loadContainerRuntime(): Promise<typeof LocalContainerRuntime> {
  try {
    // Build the specifier at runtime so the bundler cannot statically resolve
    // (and fail to find) the optional `@cloudflare/containers` package.
    const specifier = ["@cloudflare", "containers"].join("/");
    const runtime = (await import(specifier)) as unknown as {
      Container?: typeof LocalContainerRuntime;
    };
    return runtime.Container ?? LocalContainerRuntime;
  } catch {
    return LocalContainerRuntime;
  }
}

const ContainerBase = await loadContainerRuntime();
const containerRuntimeAvailable = ContainerBase !== LocalContainerRuntime;

export class ActionsJobRunner extends ContainerBase {
  defaultPort = CONTAINER_PORT;
  requiredPorts = [CONTAINER_PORT];
  sleepAfter = "5m";
  entrypoint = CONTAINER_ENTRYPOINT;

  readonly #state: DurableObjectState;
  readonly #jobEnv: JobRunnerEnv;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: JobRunnerEnv) {
    super(ctx as unknown, env as unknown);
    this.#state = ctx;
    this.#jobEnv = env;
    this.envVars = { PORT: String(CONTAINER_PORT) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && /\/run(\/|$)/u.test(url.pathname)) {
      const dispatch = (await request.json()) as ActionsJobDispatch;
      // Run in the background: the coordinator must not block on the whole job.
      const run = this.#runJob(dispatch).catch((error) => {
        console.error("actions job runner failed", error);
      });
      this.#retain(run);
      return Response.json({ accepted: true }, { status: 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  #retain(promise: Promise<unknown>): void {
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise));
    this.#state.waitUntil?.(promise);
  }

  /** Forward the job to the container, then relay the result to the coordinator. */
  async #runJob(dispatch: ActionsJobDispatch): Promise<void> {
    let result: ActionsJobResult;
    try {
      if (!containerRuntimeAvailable) {
        throw new Error("Cloudflare Containers runtime is unavailable");
      }
      result = await this.#executeInContainer(dispatch);
    } catch (error) {
      result = failureResult(dispatch, error);
    }
    await this.#reportToCoordinator(dispatch, result);
  }

  async #executeInContainer(dispatch: ActionsJobDispatch): Promise<ActionsJobResult> {
    const runtime = this as unknown as ContainerRuntime;
    await runtime.startAndWaitForPorts([CONTAINER_PORT], undefined, {
      envVars: this.envVars,
      entrypoint: this.entrypoint,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), dispatch.timeoutMs);
    try {
      const response = await runtime.containerFetch(
        new Request(`http://runner.internal/runs/${encodeURIComponent(dispatch.jobId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(dispatch),
          signal: controller.signal,
        }),
        CONTAINER_PORT,
      );
      if (!response.ok) {
        throw new Error(`container step server returned ${response.status}`);
      }
      const parsed = (await response.json()) as ActionsJobResult;
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async #reportToCoordinator(dispatch: ActionsJobDispatch, result: ActionsJobResult): Promise<void> {
    const namespace = this.#jobEnv.ACTIONS_RUN;
    if (!namespace) return;
    const stub = namespace.get(namespace.idFromName(dispatch.runId));
    await stub.fetch(
      new Request("https://actions-run.internal/job-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      }),
    );
  }
}

function failureResult(dispatch: ActionsJobDispatch, error: unknown): ActionsJobResult {
  const conclusion: RunConclusion = "failure";
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  return {
    runId: dispatch.runId,
    jobId: dispatch.jobId,
    conclusion,
    logsR2Key: null,
    steps: dispatch.steps.map((step) => ({
      stepId: step.stepId,
      number: step.number,
      conclusion,
      exitCode: null,
      startedAt: now,
      completedAt: now,
      errorMessage: message,
    })),
  };
}
