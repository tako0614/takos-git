import { createHash, randomBytes } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_PROVIDER_SOURCES = [
  "cloudflare/cloudflare",
  "registry.opentofu.org/cloudflare/cloudflare",
] as const;
const MAX_PAGES = 100_000;
const MAX_READY_ATTEMPTS = 10;

export type PurgeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PurgeR2Environment = Record<string, string | undefined>;

export interface PurgedBucket {
  readonly bucketName: string;
  readonly deleted: number;
}

export interface PurgeR2Result {
  readonly kind: "takos-git.r2-pre-destroy@v1";
  readonly status: "succeeded";
  readonly buckets: readonly PurgedBucket[];
  readonly deleted: number;
  readonly cleanersRemoved: true;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return undefined;
}

function parsedOutputs(
  env: PurgeR2Environment,
): Record<string, unknown> | undefined {
  if (!env.TAKOSUMI_OUTPUTS_JSON?.trim()) return undefined;
  let outputs: unknown;
  try {
    outputs = JSON.parse(env.TAKOSUMI_OUTPUTS_JSON);
  } catch {
    throw new Error("TAKOSUMI_OUTPUTS_JSON must be valid JSON");
  }
  if (!isRecord(outputs)) {
    throw new Error("TAKOSUMI_OUTPUTS_JSON must be an object");
  }
  return outputs;
}

function outputBucketNames(
  env: PurgeR2Environment,
  outputs: Record<string, unknown> | undefined,
): string[] {
  const directObject = env.TAKOS_GIT_R2_BUCKET_NAME?.trim();
  const directActions = env.TAKOS_GIT_ACTIONS_R2_BUCKET_NAME?.trim();
  if (directObject) {
    return [...new Set([directObject, directActions].filter(Boolean))] as string[];
  }
  if (!outputs) throw new Error("TAKOSUMI_OUTPUTS_JSON is required");
  const objectBucket = outputValue(outputs.object_bucket_name)?.trim();
  if (!objectBucket) throw new Error("object_bucket_name output is required");
  const actionsBucket = outputValue(outputs.actions_logs_bucket_name)?.trim();
  return [...new Set([objectBucket, actionsBucket].filter(Boolean))] as string[];
}

function httpsApiBase(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/+$/u, "");
}

function providerApiBase(env: PurgeR2Environment): string | undefined {
  const raw = env.TAKOSUMI_PROVIDER_CONFIGS_JSON?.trim();
  if (!raw) return undefined;
  let configs: unknown;
  try {
    configs = JSON.parse(raw);
  } catch {
    throw new Error("TAKOSUMI_PROVIDER_CONFIGS_JSON must be valid JSON");
  }
  if (!isRecord(configs)) {
    throw new Error("TAKOSUMI_PROVIDER_CONFIGS_JSON must be an object");
  }
  const entries = CLOUDFLARE_PROVIDER_SOURCES.map((source) => configs[source]).filter(
    (value) => value !== undefined,
  );
  if (entries.length > 1) {
    throw new Error("TAKOSUMI_PROVIDER_CONFIGS_JSON contains duplicate Cloudflare provider sources");
  }
  const config = entries[0];
  if (config === undefined) return undefined;
  if (!isRecord(config)) {
    throw new Error("Cloudflare provider config must be an object");
  }
  for (const key of Object.keys(config)) {
    if (/(secret|token|password|credential|private_?key|api_?key)/iu.test(key)) {
      throw new Error("TAKOSUMI_PROVIDER_CONFIGS_JSON must contain only non-secret provider configuration");
    }
  }
  const baseUrl = config.base_url;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  return httpsApiBase(baseUrl, "Cloudflare provider base_url");
}

function apiExecutionContext(env: PurgeR2Environment): {
  readonly apiBase: string;
  readonly directCloudflare: boolean;
} {
  const mode = env.TAKOS_GIT_CLOUDFLARE_API_MODE?.trim() ?? "";
  if (mode !== "" && mode !== "direct") {
    throw new Error("TAKOS_GIT_CLOUDFLARE_API_MODE must be empty or direct");
  }
  const serviceBase = env.TAKOS_GIT_PURGE_API_BASE_URL?.trim();
  const configuredProviderBase = providerApiBase(env);
  if (serviceBase && configuredProviderBase) {
    throw new Error("configure only one of TAKOS_GIT_PURGE_API_BASE_URL or TAKOSUMI_PROVIDER_CONFIGS_JSON");
  }
  if (serviceBase) {
    return {
      apiBase: httpsApiBase(serviceBase, "TAKOS_GIT_PURGE_API_BASE_URL"),
      directCloudflare: mode === "direct",
    };
  }
  if (configuredProviderBase) {
    return {
      apiBase: configuredProviderBase,
      directCloudflare:
        mode === "direct" || configuredProviderBase === DEFAULT_API_BASE_URL,
    };
  }
  if (mode === "direct") {
    return {
      apiBase: httpsApiBase(
        env.CLOUDFLARE_API_BASE_URL ?? DEFAULT_API_BASE_URL,
        "CLOUDFLARE_API_BASE_URL",
      ),
      directCloudflare: true,
    };
  }
  throw new Error(
    "Cloudflare API base is unresolved; lifecycle execution must provide non-secret TAKOSUMI_PROVIDER_CONFIGS_JSON or explicitly select direct mode",
  );
}

function responseCleanerOrigin(payload: Record<string, unknown>): string | undefined {
  const result = payload.result;
  if (!isRecord(result)) return undefined;
  const value =
    typeof result.url === "string"
      ? result.url
      : typeof result.origin === "string"
        ? result.origin
        : typeof result.hostname === "string"
          ? `https://${result.hostname}`
          : undefined;
  if (!value) return undefined;
  const origin = httpsApiBase(value, "temporary cleaner origin");
  const parsed = new URL(origin);
  if (parsed.pathname !== "/") {
    throw new Error("temporary cleaner origin must be a bare HTTPS origin");
  }
  return parsed.origin;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = (await response.json().catch(() => null)) as unknown;
  return isRecord(value) ? value : {};
}

async function cloudflareRequest(
  fetchImpl: PurgeFetch,
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
      `Cloudflare API ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${response.status}`,
    );
  }
  return payload;
}

async function removeCleaner(
  fetchImpl: PurgeFetch,
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
    throw new Error(`temporary R2 cleaner removal failed: ${response.status}`);
  }
}

export function r2CleanerWorkerSource(tokenSha256: string): string {
  return `const EXPECTED_TOKEN_SHA256=${JSON.stringify(tokenSha256)};
async function authorized(request){
 const match=/^Bearer\\s+(.+)$/.exec(request.headers.get("authorization")||"");
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(match?.[1]||"")));
 return [...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join("")===EXPECTED_TOKEN_SHA256;
}
export default {async fetch(request,env){
 if(request.method!=="POST"||new URL(request.url).pathname!=="/purge"||!(await authorized(request)))return new Response("Not found",{status:404});
 const page=await env.BUCKET.list({limit:1000});
 const keys=page.objects.map((object)=>object.key);
 if(keys.length>0)await env.BUCKET.delete(keys);
 return Response.json({ok:true,deleted:keys.length,done:keys.length===0});
}};`;
}

async function invokeCleanerPage(
  fetchImpl: PurgeFetch,
  workerUrl: string,
  token: string,
  sleep: (milliseconds: number) => Promise<unknown>,
): Promise<{ deleted: number; done: boolean }> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_READY_ATTEMPTS; attempt += 1) {
    response = await fetchImpl(`${workerUrl}/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) break;
    if (attempt < MAX_READY_ATTEMPTS) await sleep(1_000);
  }
  if (!response?.ok) {
    throw new Error(
      `temporary R2 cleaner did not become ready: ${response?.status ?? 0}`,
    );
  }
  const payload = await readJson(response);
  if (
    payload.ok !== true ||
    typeof payload.deleted !== "number" ||
    !Number.isSafeInteger(payload.deleted) ||
    payload.deleted < 0 ||
    typeof payload.done !== "boolean"
  ) {
    throw new Error("temporary R2 cleaner returned an invalid result");
  }
  return { deleted: payload.deleted, done: payload.done };
}

async function purgeBucket(
  input: {
    apiToken: string;
    accountId: string;
    apiBase: string;
    workersSubdomain?: string;
    directCloudflare: boolean;
    bucketName: string;
  },
  fetchImpl: PurgeFetch,
  sleep: (milliseconds: number) => Promise<unknown>,
): Promise<PurgedBucket> {
  const cleanerName = `takos-git-clean-${createHash("sha256")
    .update(input.bucketName)
    .digest("hex")
    .slice(0, 16)}`;
  const scriptUrl = `${input.apiBase}/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${cleanerName}`;
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: "2026-07-17",
          bindings: [
            {
              type: "r2_bucket",
              name: "BUCKET",
              bucket_name: input.bucketName,
            },
          ],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set(
    "worker.mjs",
    new Blob([r2CleanerWorkerSource(tokenHash)], {
      type: "application/javascript+module",
    }),
    "worker.mjs",
  );

  let operationError: Error | undefined;
  let deleted = 0;
  try {
    await cloudflareRequest(fetchImpl, scriptUrl, input.apiToken, {
      method: "PUT",
      body: form,
    });
    const subdomain = await cloudflareRequest(
      fetchImpl,
      `${scriptUrl}/subdomain`,
      input.apiToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      },
    );
    const workerUrl = input.directCloudflare
      ? `https://${cleanerName}.${required(input.workersSubdomain, "Cloudflare workers.dev subdomain")}.workers.dev`
      : responseCleanerOrigin(subdomain);
    if (!workerUrl) {
      throw new Error(
        "managed Cloudflare compatibility API did not return the temporary cleaner invocation origin",
      );
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await invokeCleanerPage(
        fetchImpl,
        workerUrl,
        token,
        sleep,
      );
      deleted += result.deleted;
      if (result.done) break;
      if (page === MAX_PAGES - 1) {
        throw new Error("temporary R2 cleaner exceeded page cap");
      }
    }
  } catch (error) {
    operationError =
      error instanceof Error ? error : new Error("R2 purge failed");
  }

  let cleanupError: Error | undefined;
  try {
    // The upload may have committed even when its response was lost. The name is
    // deterministic, so cleanup is always attempted after the PUT starts.
    await removeCleaner(fetchImpl, scriptUrl, input.apiToken);
  } catch (error) {
    cleanupError =
      error instanceof Error ? error : new Error("cleaner cleanup failed");
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "R2 purge and temporary cleaner cleanup both failed",
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return { bucketName: input.bucketName, deleted };
}

export async function purgeR2BeforeDestroy(
  env: PurgeR2Environment = process.env,
  fetchImpl: PurgeFetch = fetch,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<PurgeR2Result> {
  const outputs = parsedOutputs(env);
  const bucketNames = outputBucketNames(env, outputs);
  const apiToken = required(
    env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN,
    "CLOUDFLARE_API_TOKEN",
  );
  const accountId = required(
    env.TAKOS_GIT_CLOUDFLARE_ACCOUNT_ID ??
      env.CLOUDFLARE_ACCOUNT_ID ??
      outputValue(outputs?.cloudflare_account_id),
    "CLOUDFLARE_ACCOUNT_ID",
  );
  const { apiBase, directCloudflare } = apiExecutionContext(env);
  let workersSubdomain: string | undefined;
  if (directCloudflare) {
    const subdomainPayload = await cloudflareRequest(
      fetchImpl,
      `${apiBase}/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      apiToken,
      { method: "GET" },
    );
    const subdomainResult = subdomainPayload.result;
    workersSubdomain = isRecord(subdomainResult)
      ? required(
          typeof subdomainResult.subdomain === "string"
            ? subdomainResult.subdomain
            : undefined,
          "Cloudflare workers.dev subdomain",
        )
      : required(undefined, "Cloudflare workers.dev subdomain");
  }

  const buckets: PurgedBucket[] = [];
  for (const bucketName of bucketNames) {
    buckets.push(
      await purgeBucket(
        {
          apiToken,
          accountId,
          apiBase,
          ...(workersSubdomain ? { workersSubdomain } : {}),
          directCloudflare,
          bucketName,
        },
        fetchImpl,
        sleep,
      ),
    );
  }
  return {
    kind: "takos-git.r2-pre-destroy@v1",
    status: "succeeded",
    buckets,
    deleted: buckets.reduce((total, bucket) => total + bucket.deleted, 0),
    cleanersRemoved: true,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await purgeR2BeforeDestroy()));
}
