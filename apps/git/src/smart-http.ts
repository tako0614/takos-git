import {
  canAccessRepositoryOwner,
  readInternalAuth,
  repositoryAccessDenied,
} from "./auth.ts";
import {
  configuredRepositoryIsActive,
  configuredRepositoryRoot,
  isSafeSmartHttpPath,
  notImplemented,
  readConfiguredRepositoryRecord,
} from "./git.ts";

const textDecoder = new TextDecoder();

// Default push-size cap = 100 MiB. Operators can raise/lower via
// TAKOS_GIT_MAX_PUSH_SIZE (bytes). Receive-pack stdin is also re-counted
// while streaming so a chunked / unset content-length cannot bypass this.
const DEFAULT_MAX_PUSH_SIZE = 100 * 1024 * 1024;

export function isGitSmartHttpPath(pathname: string): boolean {
  return pathname.endsWith(".git") || pathname.includes(".git/");
}

export async function handleSmartHttp(request: Request): Promise<Response> {
  const auth = await readInternalAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });

  const root = configuredRepositoryRoot();
  if (!root) {
    return Response.json(notImplemented("git_smart_http_not_implemented"), {
      status: 501,
    });
  }

  const url = new URL(request.url);
  if (!isSafeSmartHttpPath(url.pathname)) {
    return Response.json({
      error: "invalid Git Smart HTTP path",
      code: "invalid_git_smart_http_path",
    }, { status: 400 });
  }

  // Force smart HTTP only: reject `GET <repo>.git/info/refs` without an
  // explicit `?service=git-upload-pack` or `?service=git-receive-pack`
  // query param. Dumb HTTP (no service param) leaks loose-object packs
  // through git http-backend and we do not want to support it.
  if (url.pathname.endsWith("/info/refs")) {
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return Response.json({
        error:
          "info/refs requires ?service=git-upload-pack or git-receive-pack",
        code: "git_smart_http_service_required",
      }, { status: 400 });
    }
  }

  const repositoryId = repositoryIdFromSmartHttpPath(url.pathname);
  const active = await configuredRepositoryIsActive(repositoryId);
  if (active === false) {
    return Response.json({
      error: "repository not found",
      code: "git_repository_not_found",
      repositoryId,
    }, { status: 404 });
  }
  const repository = await readConfiguredRepositoryRecord(repositoryId);
  // ACL is metadata-driven: if the metadata layer has no record for this
  // repository id, deny the request even if the on-disk bare repo exists.
  // Falling through to `git http-backend` would expose an unmanaged repo.
  if (!repository) {
    return Response.json({
      error: "repository not found",
      code: "git_repository_not_found",
      repositoryId,
    }, { status: 404 });
  }
  const receivePack = isReceivePack(url.pathname, url.searchParams);
  const access = receivePack ? "write" : "read";
  if (!canAccessRepositoryOwner(auth, repository.ownerSpaceId, access)) {
    return Response.json(repositoryAccessDenied(repositoryId), {
      status: 403,
    });
  }

  // Enforce push size limit before spawning git http-backend so an
  // oversize body cannot fill disk via pack receive.
  const maxPushSize = configuredMaxPushSize();
  if (receivePack) {
    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw) {
      const declared = Number(contentLengthRaw);
      if (
        Number.isFinite(declared) && declared >= 0 && declared > maxPushSize
      ) {
        return Response.json({
          error: "push body exceeds TAKOS_GIT_MAX_PUSH_SIZE",
          code: "git_smart_http_push_too_large",
          maxBytes: maxPushSize,
        }, { status: 413 });
      }
    }
  }

  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("content-length") ?? "0";
  // Build a closed-shape env so `git http-backend` does not inherit
  // `GIT_DIR`, `GIT_CONFIG_*`, `SSH_*`, `LD_*`, `HTTP_PROXY`, or any
  // other env from the parent process that could redirect it at a
  // different repo / fetch path / shared library. The base env carries
  // only PATH (sanitized), HOME (temp dir), LANG=C/LC_ALL=C, plus the
  // CGI variables the http-backend protocol requires.
  const env: Record<string, string> = {
    ...buildSmartHttpBaseEnv(),
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
    REQUEST_METHOD: request.method,
    CONTENT_TYPE: contentType ?? "",
    CONTENT_LENGTH: contentLength,
    REMOTE_USER: "takos-git",
  };

  const child = new Deno.Command("git", {
    args: ["http-backend"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env,
  }).spawn();

  // Stream request body to subprocess stdin without buffering the entire
  // payload. For receive-pack, also re-count bytes as they stream so a
  // chunked or missing content-length still cannot bypass the size cap.
  let oversize = false;
  if (request.body) {
    const writer = child.stdin.getWriter();
    try {
      let received = 0;
      for await (const chunk of request.body) {
        if (receivePack) {
          received += chunk.byteLength;
          if (received > maxPushSize) {
            oversize = true;
            break;
          }
        }
        await writer.write(chunk);
      }
    } catch (_error) {
      // Subprocess may have closed stdin; treat as transport error below.
    } finally {
      try {
        await writer.close();
      } catch (_closeError) {
        // ignore close errors; output handling below reports the failure
      }
    }
  } else {
    try {
      await child.stdin.getWriter().close();
    } catch (_error) {
      // ignore
    }
  }

  if (oversize) {
    try {
      child.kill("SIGTERM");
    } catch (_error) {
      // process may already be gone
    }
    // Drain child to release resources; ignore output content.
    await child.output().catch(() => {});
    return Response.json({
      error: "push body exceeds TAKOS_GIT_MAX_PUSH_SIZE",
      code: "git_smart_http_push_too_large",
      maxBytes: maxPushSize,
    }, { status: 413 });
  }

  // TODO(takos-git): switch to true streaming response (TransformStream-
  // based header peel). Current implementation buffers stdout but caps the
  // total buffered size to MAX_BUFFERED_RESPONSE_BYTES so a single git
  // http-backend invocation cannot exhaust process memory.
  return await collectAndRespond(child);
}

const MAX_BUFFERED_RESPONSE_BYTES = 500 * 1024 * 1024;

async function collectAndRespond(child: Deno.ChildProcess): Promise<Response> {
  let buffered: Uint8Array = new Uint8Array(0);
  let stderrChunks: Uint8Array[] = [];
  let truncated = false;
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (
        buffered.byteLength + value.byteLength > MAX_BUFFERED_RESPONSE_BYTES
      ) {
        truncated = true;
        break;
      }
      const next = new Uint8Array(buffered.byteLength + value.byteLength);
      next.set(buffered, 0);
      next.set(value, buffered.byteLength);
      buffered = next;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) {
      // ignore
    }
  }

  // Drain stderr so the process can exit; capture for diagnostic logs.
  try {
    const stderrReader = child.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await stderrReader.read();
        if (done) break;
        if (value) stderrChunks.push(value);
      }
    } finally {
      try {
        stderrReader.releaseLock();
      } catch (_error) {
        // ignore
      }
    }
  } catch (_error) {
    stderrChunks = [];
  }

  if (truncated) {
    try {
      child.kill("SIGTERM");
    } catch (_error) {
      // ignore
    }
    await child.status.catch(() => {});
    return Response.json({
      error: "git http-backend response exceeds buffered cap",
      code: "git_smart_http_response_too_large",
    }, { status: 502 });
  }

  const status = await child.status;
  if (!status.success) {
    return Response.json({
      error: "git http-backend failed",
      code: "git_smart_http_backend_failed",
    }, { status: 500 });
  }
  return cgiResponse(buffered);
}

function configuredMaxPushSize(): number {
  const raw = Deno.env.get("TAKOS_GIT_MAX_PUSH_SIZE")?.trim();
  if (!raw) return DEFAULT_MAX_PUSH_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PUSH_SIZE;
  return Math.floor(parsed);
}

function isReceivePack(path: string, params: URLSearchParams): boolean {
  return path.endsWith("/git-receive-pack") ||
    params.get("service") === "git-receive-pack";
}

function repositoryIdFromSmartHttpPath(pathname: string): string {
  const withoutPrefix = pathname.startsWith("/git/")
    ? pathname.slice("/git/".length)
    : pathname.slice(1);
  const gitIndex = withoutPrefix.indexOf(".git");
  const raw = gitIndex >= 0 ? withoutPrefix.slice(0, gitIndex) : withoutPrefix;
  return decodeURIComponent(raw);
}

function cgiResponse(output: Uint8Array): Response {
  const boundary = findHeaderBoundary(output);
  if (!boundary) {
    return Response.json({
      error: "git http-backend returned an invalid CGI response",
      code: "git_smart_http_invalid_backend_response",
    }, { status: 500 });
  }

  const headersText = textDecoder.decode(output.slice(0, boundary.headerEnd));
  const headers = new Headers();
  let status = 200;
  for (const line of headersText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number(value.split(/\s+/, 1)[0]) || status;
    } else {
      headers.append(name, value);
    }
  }
  const body = output.slice(boundary.bodyStart);
  // Copy into a fresh ArrayBuffer so the response body type is stable.
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return new Response(copy, { status, headers });
}

function findHeaderBoundary(
  output: Uint8Array,
): { headerEnd: number; bodyStart: number } | undefined {
  for (let index = 0; index < output.length - 3; index++) {
    if (
      output[index] === 13 && output[index + 1] === 10 &&
      output[index + 2] === 13 && output[index + 3] === 10
    ) {
      return { headerEnd: index, bodyStart: index + 4 };
    }
  }
  for (let index = 0; index < output.length - 1; index++) {
    if (output[index] === 10 && output[index + 1] === 10) {
      return { headerEnd: index, bodyStart: index + 2 };
    }
  }
}

let cachedSmartHttpHome: string | undefined;

function smartHttpHome(): string {
  if (cachedSmartHttpHome !== undefined) return cachedSmartHttpHome;
  try {
    cachedSmartHttpHome = Deno.makeTempDirSync({
      prefix: "takos-git-http-home-",
    });
  } catch {
    cachedSmartHttpHome = "/tmp";
  }
  return cachedSmartHttpHome;
}

/**
 * Closed-shape base environment for the `git http-backend` CGI process.
 * Drops `GIT_*` overrides, `SSH_*`, `LD_*`, `XDG_*`, and proxy vars from
 * the parent inherit so a hostile env cannot redirect smart HTTP at a
 * different repo or swap shared libraries under git.
 */
function buildSmartHttpBaseEnv(): Record<string, string> {
  const overridePath = Deno.env.get("TAKOS_GIT_PATH")?.trim();
  const path = overridePath && overridePath.length > 0
    ? overridePath
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return {
    PATH: path,
    HOME: smartHttpHome(),
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
  };
}
