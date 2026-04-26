import { Hono } from "hono";
import {
  decodeActorContext,
  type GitRepositorySummary,
  type GitResolveSourceRequest,
  type GitResolveSourceResponse,
  TAKOS_GIT_INTERNAL_PATHS,
  TAKOS_INTERNAL_ACTOR_HEADER,
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  verifyInternalRequestSignature,
} from "takos-git-contract";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "takos-git" }));

app.post(TAKOS_GIT_INTERNAL_PATHS.resolveSource, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<GitResolveSourceRequest>();
  const response: GitResolveSourceResponse = {
    sourceRef: request.sourceRef,
    repositoryId: request.repositoryId,
    resolvedCommit: request.sourceRef,
  };
  return c.json(response);
});

app.get(TAKOS_GIT_INTERNAL_PATHS.repositories, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositories: GitRepositorySummary[] = [];
  return c.json({ repositories });
});

function readInternalAuth(
  request: Request,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  return readInternalAuthWithSecret(request, secret);
}

async function readInternalAuthWithSecret(
  request: Request,
  secret: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!secret) return { ok: false, error: "internal service secret missing" };
  const signature = request.headers.get(TAKOS_INTERNAL_SIGNATURE_HEADER);
  if (!signature) {
    return { ok: false, error: "missing internal signature" };
  }
  const timestamp = request.headers.get(TAKOS_INTERNAL_TIMESTAMP_HEADER);
  if (!timestamp) {
    return { ok: false, error: "missing internal timestamp" };
  }
  const actorHeader = request.headers.get(TAKOS_INTERNAL_ACTOR_HEADER);
  if (!actorHeader) return { ok: false, error: "missing actor context" };
  try {
    decodeActorContext(actorHeader);
  } catch {
    return { ok: false, error: "invalid actor context" };
  }
  const body = await request.clone().text();
  const path = new URL(request.url).pathname;
  const valid = await verifyInternalRequestSignature({
    method: request.method,
    path,
    body,
    timestamp,
    secret,
    signature,
  });
  if (!valid) return { ok: false, error: "invalid internal signature" };
  return { ok: true };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
