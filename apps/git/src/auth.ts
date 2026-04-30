import {
  decodeActorContext,
  TAKOS_INTERNAL_ACTOR_HEADER,
  TAKOS_INTERNAL_AUDIENCE_HEADER,
  TAKOS_INTERNAL_CALLER_HEADER,
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  verifySignedInternalRequestFromHeaders,
} from "takos-git-contract";

const TAKOS_GIT_EXPECTED_AUDIENCE = "takos-git";
const TAKOS_GIT_DEFAULT_INTERNAL_CALLERS = ["takos-app", "takos-paas"];

export function readInternalAuth(
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
  const caller = request.headers.get(TAKOS_INTERNAL_CALLER_HEADER);
  if (!caller) return { ok: false, error: "missing internal caller" };
  if (!allowedInternalCallers().includes(caller)) {
    return { ok: false, error: "invalid internal caller" };
  }
  const audience = request.headers.get(TAKOS_INTERNAL_AUDIENCE_HEADER);
  if (!audience) return { ok: false, error: "missing internal audience" };
  const body = await request.clone().text();
  const path = new URL(request.url).pathname;
  const valid = await verifySignedInternalRequestFromHeaders({
    method: request.method,
    path,
    body,
    secret,
    headers: request.headers,
    expectedCaller: caller,
    expectedAudience: TAKOS_GIT_EXPECTED_AUDIENCE,
  });
  if (!valid) return { ok: false, error: "invalid internal signature" };
  return { ok: true };
}

function allowedInternalCallers(): string[] {
  const configured = Deno.env.get("TAKOS_GIT_INTERNAL_CALLERS");
  return (configured?.split(",") ?? TAKOS_GIT_DEFAULT_INTERNAL_CALLERS)
    .map((caller) => caller.trim())
    .filter(Boolean);
}
