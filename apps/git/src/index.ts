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
} from "takos-git-contract";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "takos-git" }));

app.post(TAKOS_GIT_INTERNAL_PATHS.resolveSource, async (c) => {
  const auth = readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<GitResolveSourceRequest>();
  const response: GitResolveSourceResponse = {
    sourceRef: request.sourceRef,
    repositoryId: request.repositoryId,
    resolvedCommit: request.sourceRef,
  };
  return c.json(response);
});

app.get(TAKOS_GIT_INTERNAL_PATHS.repositories, (c) => {
  const auth = readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositories: GitRepositorySummary[] = [];
  return c.json({ repositories });
});

function readInternalAuth(
  request: Request,
): { ok: true } | { ok: false; error: string } {
  const secret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  if (!secret) return { ok: false, error: "internal service secret missing" };
  if (!request.headers.get(TAKOS_INTERNAL_SIGNATURE_HEADER)) {
    return { ok: false, error: "missing internal signature" };
  }
  if (!request.headers.get(TAKOS_INTERNAL_TIMESTAMP_HEADER)) {
    return { ok: false, error: "missing internal timestamp" };
  }
  const actorHeader = request.headers.get(TAKOS_INTERNAL_ACTOR_HEADER);
  if (!actorHeader) return { ok: false, error: "missing actor context" };
  try {
    decodeActorContext(actorHeader);
  } catch {
    return { ok: false, error: "invalid actor context" };
  }
  return { ok: true };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
