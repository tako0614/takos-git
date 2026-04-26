const textEncoder = new TextEncoder();

export const TAKOS_INTERNAL_SIGNATURE_HEADER = "x-takos-internal-signature";
export const TAKOS_INTERNAL_TIMESTAMP_HEADER = "x-takos-internal-timestamp";
export const TAKOS_INTERNAL_REQUEST_ID_HEADER = "x-takos-request-id";
export const TAKOS_INTERNAL_ACTOR_HEADER = "x-takos-actor-context";

export interface TakosActorContext {
  actorAccountId: string;
  spaceId?: string;
  roles: string[];
  requestId: string;
}

export interface GitRepositorySummary {
  id: string;
  name: string;
  ownerAccountId: string;
  defaultBranch: string;
}

export interface GitResolveSourceRequest {
  actor: TakosActorContext;
  repositoryId: string;
  sourceRef: string;
}

export interface GitResolveSourceResponse {
  repositoryId: string;
  sourceRef: string;
  resolvedCommit: string;
}

export const TAKOS_GIT_INTERNAL_PATHS = {
  repositories: "/internal/repositories",
  resolveSource: "/internal/source/resolve",
} as const;

export interface SignedInternalRequestInput {
  method: string;
  path: string;
  body: string;
  timestamp: string;
}

export function canonicalInternalRequest(
  input: SignedInternalRequestInput,
): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.body,
  ].join("\n");
}

export function encodeActorContext(actor: TakosActorContext): string {
  return btoa(JSON.stringify(actor));
}

export function decodeActorContext(value: string): TakosActorContext {
  const parsed = JSON.parse(atob(value)) as TakosActorContext;
  if (
    !parsed.actorAccountId || !parsed.requestId || !Array.isArray(parsed.roles)
  ) {
    throw new TypeError("Invalid Takos actor context");
  }
  return parsed;
}

export async function signInternalRequest(
  input: SignedInternalRequestInput & {
    actor: TakosActorContext;
    secret: string;
  },
): Promise<{ headers: Record<string, string> }> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(canonicalInternalRequest(input)),
  );
  return {
    headers: {
      [TAKOS_INTERNAL_ACTOR_HEADER]: encodeActorContext(input.actor),
      [TAKOS_INTERNAL_REQUEST_ID_HEADER]: input.actor.requestId,
      [TAKOS_INTERNAL_TIMESTAMP_HEADER]: input.timestamp,
      [TAKOS_INTERNAL_SIGNATURE_HEADER]: toHex(signature),
    },
  };
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
