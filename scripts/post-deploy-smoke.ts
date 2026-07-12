import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const outputs = await readCapsuleOutputs();
const baseInput =
  process.env.TAKOS_GIT_URL ??
  process.env.TAKOS_GIT_HTTP_BASE_URL?.replace(/\/git\/?$/, "") ??
  stringOutput(outputs, "url", "public_url", "launch_url") ??
  process.env.TAKOSUMI_CAPSULE_PUBLIC_URL ??
  "";
const token = process.env.TAKOS_GIT_ACCESS_TOKEN ?? "";
const repo = process.env.TAKOS_GIT_SMOKE_REPO ?? "";
const skipRefs = process.env.TAKOS_GIT_SKIP_REFS === "1";
const delegateCleanupToDestroy =
  process.env.TAKOS_GIT_DELEGATE_CLEANUP_TO_DESTROY === "1";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveBaseUrl(input: string): URL {
  if (!input) fail("TAKOS_GIT_URL or TAKOS_GIT_HTTP_BASE_URL is required");
  try {
    const url = new URL(input);
    url.pathname = url.pathname.replace(/\/$/, "");
    return url;
  } catch {
    fail("TAKOS_GIT_URL must be a valid URL");
  }
}

function repoPath(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

async function expectOk(url: URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    fail(
      `${init?.method ?? "GET"} ${url.pathname}${url.search} failed: ${response.status}`,
    );
  }
  return response;
}

async function readCapsuleOutputs(): Promise<Record<string, unknown>> {
  const file = process.env.TAKOSUMI_CAPSULE_OUTPUTS_FILE;
  if (!file) return {};
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stringOutput(
  outputs: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = outputs[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function callMcp(
  baseUrl: URL,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await expectOk(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: { structuredContent?: Record<string, unknown> };
  };
  if (payload.error)
    fail(`MCP ${name} failed: ${payload.error.message ?? "unknown error"}`);
  return payload.result?.structuredContent ?? {};
}

async function runGit(
  cwd: string,
  accessToken: string,
  ...args: string[]
): Promise<void> {
  const authorization = Buffer.from(`x:${accessToken}`).toString("base64");
  const child = spawn("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? cwd,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((done) => {
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });
  if (exitCode !== 0) {
    fail(
      `git ${args[0] ?? "command"} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
}

const baseUrl = resolveBaseUrl(baseInput);
const rootUrl = new URL("/", baseUrl);
const healthUrl = new URL("/healthz", baseUrl);

await expectOk(rootUrl);
await expectOk(healthUrl);
const checks = ["root", "health"];

if (!skipRefs) {
  if (!token)
    fail("TAKOS_GIT_ACCESS_TOKEN is required unless TAKOS_GIT_SKIP_REFS=1");
  if (!repo)
    fail("TAKOS_GIT_SMOKE_REPO is required unless TAKOS_GIT_SKIP_REFS=1");
  const normalizedRepo = repoPath(repo);
  const repoUrl = new URL(`/git/${normalizedRepo}.git`, baseUrl);
  const refsUrl = new URL(`${repoUrl.pathname}/info/refs`, baseUrl);
  refsUrl.searchParams.set("service", "git-upload-pack");
  const tempRoot = await mkdtemp(resolve(tmpdir(), "takos-git-smoke-"));
  let repositoryCreated = false;
  try {
    await callMcp(baseUrl, token, "git_repo_create", { repo });
    repositoryCreated = true;
    checks.push("repository.create");

    const refs = await expectOk(refsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    const contentType = refs.headers.get("content-type") ?? "";
    if (!contentType.includes("application/x-git-upload-pack-advertisement")) {
      fail(`unexpected git refs content-type: ${contentType}`);
    }
    checks.push("smart-http.refs");

    const sourceDir = resolve(tempRoot, "source");
    const cloneDir = resolve(tempRoot, "clone");
    await runGit(tempRoot, token, "init", "--initial-branch=main", sourceDir);
    await runGit(sourceDir, token, "config", "user.name", "Takosumi E2E");
    await runGit(
      sourceDir,
      token,
      "config",
      "user.email",
      "e2e@example.invalid",
    );
    await writeFile(
      resolve(sourceDir, "README.md"),
      "takos-git functional e2e\n",
    );
    await runGit(sourceDir, token, "add", "README.md");
    await runGit(sourceDir, token, "commit", "-m", "functional e2e");
    await runGit(
      sourceDir,
      token,
      "remote",
      "add",
      "origin",
      repoUrl.toString(),
    );
    await runGit(sourceDir, token, "push", "-u", "origin", "main");
    checks.push("smart-http.push");

    await runGit(tempRoot, token, "clone", repoUrl.toString(), cloneDir);
    if (
      (await readFile(resolve(cloneDir, "README.md"), "utf8")) !==
      "takos-git functional e2e\n"
    ) {
      fail("cloned repository content did not round-trip");
    }
    checks.push("smart-http.clone");
  } finally {
    if (repositoryCreated && !delegateCleanupToDestroy) {
      await callMcp(baseUrl, token, "git_repo_delete", { repo });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (delegateCleanupToDestroy) {
    checks.push("repository.cleanup-delegated-to-destroy");
  } else {
    const deletedRefs = await fetch(refsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (deletedRefs.status !== 404) {
      fail(`deleted repository remained readable: ${deletedRefs.status}`);
    }
    checks.push("repository.cleanup");
  }
}

console.log(
  JSON.stringify({
    kind: "takosumi.capsule-functional-probe@v1",
    status: "passed",
    product: "takos-git",
    checks: checks.map((name) => ({ name, status: "passed" })),
    ...(delegateCleanupToDestroy
      ? { cleanupDelegatedToDestroy: true }
      : { cleanupVerified: true }),
    ok: true,
    service: "takos-git",
    checkedRefs: !skipRefs,
  }),
);
