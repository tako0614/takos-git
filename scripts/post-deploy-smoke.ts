const baseInput =
  process.env.TAKOS_GIT_URL ??
  process.env.TAKOS_GIT_HTTP_BASE_URL?.replace(/\/git\/?$/, "") ??
  "";
const token = process.env.TAKOS_GIT_ACCESS_TOKEN ?? "";
const repo = process.env.TAKOS_GIT_SMOKE_REPO ?? "";
const skipRefs = process.env.TAKOS_GIT_SKIP_REFS === "1";

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
    fail(`${init?.method ?? "GET"} ${url.pathname}${url.search} failed: ${response.status}`);
  }
  return response;
}

const baseUrl = resolveBaseUrl(baseInput);
const rootUrl = new URL("/", baseUrl);
const healthUrl = new URL("/healthz", baseUrl);

await expectOk(rootUrl);
await expectOk(healthUrl);

if (!skipRefs) {
  if (!token) fail("TAKOS_GIT_ACCESS_TOKEN is required unless TAKOS_GIT_SKIP_REFS=1");
  if (!repo) fail("TAKOS_GIT_SMOKE_REPO is required unless TAKOS_GIT_SKIP_REFS=1");
  const refsUrl = new URL(`/git/${repoPath(repo)}.git/info/refs`, baseUrl);
  refsUrl.searchParams.set("service", "git-upload-pack");
  const refs = await expectOk(refsUrl, { headers: { authorization: `Bearer ${token}` } });
  const contentType = refs.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-git-upload-pack-advertisement")) {
    fail(`unexpected git refs content-type: ${contentType}`);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    service: "takos-git",
    url: rootUrl.toString(),
    checkedRefs: !skipRefs,
  }),
);
