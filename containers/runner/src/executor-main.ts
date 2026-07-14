/**
 * Runner container entrypoint — the HTTP step server the image runs.
 *
 * `Bun.serve` listens on `$PORT` (8080). The job-runner Durable Object POSTs an
 * {@link ActionsJobDispatch} to `/runs/:jobId`; this program checks out the
 * run-pinned tree, runs the step loop ({@link executeJob}) with a real shell, and
 * returns the {@link ActionsJobResult}. All worker callbacks
 * (`/internal/actions/{checkout,logs,artifacts}`) are authenticated with the
 * per-run HMAC bearer carried in the dispatch (`callbackToken`).
 *
 * DEPLOY-ONLY: this program runs inside the Cloudflare Container image, which
 * cannot be built or run in this environment. The pure step loop it calls
 * (`step-executor.ts`) is unit-tested separately.
 */

import type {
  ActionsJobDispatch,
  ActionsJobResult,
} from "../../../src/features/actions/runner/contract.ts";
import { readTar } from "../../../src/features/actions/runner/tar.ts";
import { executeJob, type ArtifactClient, type CheckoutClient, type LogSink } from "./step-executor.ts";
import { spawnShell } from "./spawn-shell.ts";

const DEFAULT_PORT = 8080;

function pathJoin(base: string, sub: string): string {
  const cleanBase = base.replace(/\/+$/u, "");
  const cleanSub = sub.replace(/^\/+/u, "");
  return cleanSub ? `${cleanBase}/${cleanSub}` : cleanBase;
}

function callbackHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(extra ?? {}) };
}

/** Fetch + extract the run-pinned tree tar into the workspace. */
function makeCheckoutClient(dispatch: ActionsJobDispatch): CheckoutClient {
  return {
    async checkout(dest: string): Promise<void> {
      const url = `${dispatch.callbackBaseUrl}/internal/actions/checkout?runId=${encodeURIComponent(dispatch.runId)}`;
      const response = await fetch(url, { headers: callbackHeaders(dispatch.callbackToken) });
      if (!response.ok) throw new Error(`checkout failed: ${response.status}`);
      const archive = new Uint8Array(await response.arrayBuffer());
      for (const member of readTar(archive)) {
        await Bun.write(pathJoin(dest, member.path), member.bytes);
      }
    },
  };
}

/** Upload one artifact file back to the worker. */
function makeArtifactClient(dispatch: ActionsJobDispatch): ArtifactClient {
  return {
    async upload(name: string, sourcePath: string): Promise<void> {
      const file = Bun.file(sourcePath);
      if (!(await file.exists())) throw new Error(`artifact path not found: ${sourcePath}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url =
        `${dispatch.callbackBaseUrl}/internal/actions/artifacts` +
        `?runId=${encodeURIComponent(dispatch.runId)}` +
        `&jobId=${encodeURIComponent(dispatch.jobId)}` +
        `&name=${encodeURIComponent(name)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: callbackHeaders(dispatch.callbackToken, { "content-type": "application/octet-stream" }),
        body: bytes,
      });
      if (!response.ok) throw new Error(`artifact upload failed: ${response.status}`);
    },
  };
}

/** A serialized log sink: appends stream in order, and the sealed R2 key is captured. */
function makeLogSink(dispatch: ActionsJobDispatch): LogSink & { logsR2Key(): string | null } {
  let chain: Promise<void> = Promise.resolve();
  let key: string | null = null;
  const sink: LogSink & { logsR2Key(): string | null } = {
    append(text: string, stepId?: string): Promise<void> {
      chain = chain.then(async () => {
        const response = await fetch(`${dispatch.callbackBaseUrl}/internal/actions/logs`, {
          method: "POST",
          headers: callbackHeaders(dispatch.callbackToken, { "content-type": "application/json" }),
          body: JSON.stringify({ runId: dispatch.runId, jobId: dispatch.jobId, stepId, chunk: text }),
        });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as { logsR2Key?: string } | null;
          if (body?.logsR2Key) key = body.logsR2Key;
        }
      });
      return chain;
    },
    logsR2Key: () => key,
  };
  return sink;
}

/** Run one dispatched job to completion, returning its result. */
export async function runDispatch(dispatch: ActionsJobDispatch): Promise<ActionsJobResult> {
  const workspaceRoot = Bun.env.RUNNER_WORKSPACE ?? "/work";
  const workspaceDir = pathJoin(workspaceRoot, dispatch.jobId);
  const logs = makeLogSink(dispatch);

  const execution = await executeJob(dispatch, {
    spawn: spawnShell,
    checkout: makeCheckoutClient(dispatch),
    artifacts: makeArtifactClient(dispatch),
    logs,
    workspaceDir,
    baseEnv: { PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: workspaceDir },
    defaultShell: "bash",
  });

  return {
    runId: dispatch.runId,
    jobId: dispatch.jobId,
    conclusion: execution.conclusion,
    steps: execution.steps,
    logsR2Key: logs.logsR2Key(),
  };
}

function startServer(): void {
  const port = Number(Bun.env.PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
  Bun.serve({
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok", service: "takos-git-actions-runner" });
      }
      if (request.method === "POST" && /^\/runs\/[^/]+$/u.test(url.pathname)) {
        const dispatch = (await request.json()) as ActionsJobDispatch;
        const result = await runDispatch(dispatch);
        return Response.json(result);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  console.log(`takos-git actions runner listening on :${port}`);
}

if (import.meta.main) startServer();
