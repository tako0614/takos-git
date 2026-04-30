import { readInternalAuth } from "./auth.ts";
import {
  bytesToArrayBuffer,
  configuredRepositoryRoot,
  isSafeSmartHttpPath,
  notImplemented,
  runGit,
} from "./git.ts";

const textDecoder = new TextDecoder();

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

  const body = new Uint8Array(await request.arrayBuffer());
  const contentType = request.headers.get("content-type");
  const output = await runGit(["http-backend"], body, {
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
    REQUEST_METHOD: request.method,
    CONTENT_TYPE: contentType ?? "",
    CONTENT_LENGTH: String(body.byteLength),
    REMOTE_USER: "takos-git",
  });
  if (!output.success) {
    return Response.json({
      error: "git http-backend failed",
      code: "git_smart_http_backend_failed",
    }, { status: 500 });
  }
  return cgiResponse(output.stdout);
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
  return new Response(bytesToArrayBuffer(output.slice(boundary.bodyStart)), {
    status,
    headers,
  });
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
