import { createHash, randomBytes } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface PurgeR2Environment {
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly CF_API_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_BASE_URL?: string;
  readonly TAKOS_GIT_R2_BUCKET_NAME?: string;
  readonly TAKOS_GIT_WORKERS_SUBDOMAIN?: string;
  readonly TAKOS_GIT_PURGE_API_BASE_URL?: string;
}

export interface PurgeR2Result {
  readonly kind: "takos-git.r2-pre-destroy@v1";
  readonly status: "succeeded";
  readonly bucketName: string;
  readonly deleted: number;
  readonly cleanerRemoved: true;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiPayloadError(payload: unknown): string {
  if (!isRecord(payload)) return "unknown error";
  return JSON.stringify(payload.errors ?? payload);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : { raw: "invalid JSON object" };
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function cleanerSource(tokenSha256: string): string {
  return `const EXPECTED_TOKEN_SHA256=${JSON.stringify(tokenSha256)};
async function authorized(request){
  const match=/^Bearer\\s+(.+)$/.exec(request.headers.get("authorization")||"");
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(match?.[1]||"")));
  const actual=[...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
  return actual===EXPECTED_TOKEN_SHA256;
}
export default {async fetch(request,env){
  if(request.method!=="POST"||new URL(request.url).pathname!=="/purge"||!(await authorized(request))){
    return new Response("Not found",{status:404});
  }
  let deleted=0;
  for(;;){
    const page=await env.BUCKET.list({limit:1000});
    const keys=page.objects.map((object)=>object.key);
    if(keys.length===0)break;
    await env.BUCKET.delete(keys);
    deleted+=keys.length;
  }
  return Response.json({ok:true,deleted});
}};`;
}

async function cloudflareRequest(
  fetchImpl: typeof fetch,
  url: string,
  apiToken: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(init.headers ?? {}),
    },
  });
  const payload = await readJson(response);
  if (!response.ok || payload.success === false) {
    throw new Error(
      `Cloudflare API ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${response.status} ${apiPayloadError(payload)}`,
    );
  }
  return payload;
}

async function removeCleaner(
  fetchImpl: typeof fetch,
  scriptUrl: string,
  apiToken: string,
): Promise<void> {
  const response = await fetchImpl(scriptUrl, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  if (response.status === 404) return;
  const payload = await readJson(response);
  if (!response.ok || payload.success === false) {
    throw new Error(
      `temporary R2 cleaner removal failed: ${response.status} ${apiPayloadError(payload)}`,
    );
  }
}

export async function purgeR2BucketBeforeDestroy(
  env: PurgeR2Environment,
  fetchImpl: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<PurgeR2Result> {
  const apiToken = required(
    env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN,
    "CLOUDFLARE_API_TOKEN or CF_API_TOKEN",
  );
  const accountId = required(
    env.CLOUDFLARE_ACCOUNT_ID,
    "CLOUDFLARE_ACCOUNT_ID",
  );
  const workersSubdomain = required(
    env.TAKOS_GIT_WORKERS_SUBDOMAIN,
    "TAKOS_GIT_WORKERS_SUBDOMAIN",
  );
  const bucketName = required(
    env.TAKOS_GIT_R2_BUCKET_NAME,
    "TAKOS_GIT_R2_BUCKET_NAME",
  );
  const apiBase = (
    env.TAKOS_GIT_PURGE_API_BASE_URL ??
    env.CLOUDFLARE_API_BASE_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/u, "");
  const cleanerName = `takos-git-clean-${createHash("sha256")
    .update(bucketName)
    .digest("hex")
    .slice(0, 16)}`;
  const purgeToken = randomBytes(32).toString("hex");
  const purgeTokenHash = createHash("sha256").update(purgeToken).digest("hex");
  const workerUrl = `https://${cleanerName}.${workersSubdomain}.workers.dev`;
  const scriptUrl = `${apiBase}/accounts/${encodeURIComponent(
    accountId,
  )}/workers/scripts/${encodeURIComponent(cleanerName)}`;

  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: "2026-07-12",
          bindings: [
            { type: "r2_bucket", name: "BUCKET", bucket_name: bucketName },
          ],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set(
    "worker.mjs",
    new Blob([cleanerSource(purgeTokenHash)], {
      type: "application/javascript+module",
    }),
    "worker.mjs",
  );

  let uploaded = false;
  let result: Omit<PurgeR2Result, "cleanerRemoved"> | undefined;
  let operationError: unknown;
  try {
    await cloudflareRequest(fetchImpl, scriptUrl, apiToken, {
      method: "PUT",
      body: form,
    });
    uploaded = true;
    await cloudflareRequest(fetchImpl, `${scriptUrl}/subdomain`, apiToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });

    let response: Response | undefined;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      response = await fetchImpl(`${workerUrl}/purge`, {
        method: "POST",
        headers: { authorization: `Bearer ${purgeToken}` },
      });
      if (response.ok) break;
      if (attempt < 10) await sleep(1_000);
    }
    if (!response?.ok) {
      throw new Error(
        `temporary R2 cleaner did not become ready: ${response?.status ?? 0}`,
      );
    }
    const payload = await readJson(response);
    if (payload.ok !== true || typeof payload.deleted !== "number") {
      throw new Error("temporary R2 cleaner returned an invalid result");
    }
    result = {
      kind: "takos-git.r2-pre-destroy@v1",
      status: "succeeded",
      bucketName,
      deleted: payload.deleted,
    };
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (uploaded) {
    try {
      await removeCleaner(fetchImpl, scriptUrl, apiToken);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "R2 purge and temporary cleaner cleanup both failed",
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error("R2 purge returned no result");
  return { ...result, cleanerRemoved: true };
}

if (import.meta.main) {
  const result = await purgeR2BucketBeforeDestroy(process.env);
  console.log(JSON.stringify(result));
}
