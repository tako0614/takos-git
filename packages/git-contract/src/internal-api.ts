const textEncoder = new TextEncoder();

export const TAKOS_INTERNAL_SIGNATURE_HEADER = "x-takos-internal-signature";
export const TAKOS_INTERNAL_TIMESTAMP_HEADER = "x-takos-internal-timestamp";
export const TAKOS_INTERNAL_REQUEST_ID_HEADER = "x-takos-request-id";
export const TAKOS_INTERNAL_ACTOR_HEADER = "x-takos-actor-context";
export const TAKOS_INTERNAL_ACTOR_DIGEST_HEADER =
  "x-takos-actor-context-digest";
export const TAKOS_INTERNAL_BODY_DIGEST_HEADER = "x-takos-body-digest";
export const TAKOS_INTERNAL_NONCE_HEADER = "x-takos-nonce";
export const TAKOS_INTERNAL_CALLER_HEADER = "x-takos-caller";
export const TAKOS_INTERNAL_AUDIENCE_HEADER = "x-takos-audience";
export const TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

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

export interface GitRefSummary {
  name: string;
  target: string;
}

export interface GitRepositoryDetail extends GitRepositorySummary {
  refs: GitRefSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface GitCreateRepositoryRequest {
  id: string;
  name: string;
  ownerAccountId: string;
  defaultBranch?: string;
  refs?: GitRefSummary[] | Record<string, string>;
}

export interface GitUpdateRepositoryRequest {
  name?: string;
  ownerAccountId?: string;
  defaultBranch?: string;
  refs?: GitRefSummary[] | Record<string, string>;
}

export interface GitResolveSourceRequest {
  repositoryId: string;
  sourceRef: string;
}

export interface GitResolveSourceResponse {
  repositoryId: string;
  sourceRef: string;
  resolvedCommit: string;
  resolvedRef?: string;
}

export const TAKOS_GIT_INTERNAL_PATHS = {
  repositories: "/internal/repositories",
  repository: (repositoryId: string): string =>
    `/internal/repositories/${encodeURIComponent(repositoryId)}`,
  objects: "/internal/objects",
  resolveSource: "/internal/source/resolve",
} as const;

export interface SignedInternalRequestInput {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  requestId: string;
  nonce: string;
  caller?: string;
  audience?: string;
  bodyDigest: string;
  actorContextHeader: string;
  actorContextDigest: string;
}

export interface InternalRequestSigningInput {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  nonce?: string;
  caller?: string;
  audience?: string;
}

export function canonicalInternalRequest(
  input: SignedInternalRequestInput,
): string {
  return [
    "takos-internal-v2",
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.requestId,
    input.nonce,
    input.caller ?? "",
    input.audience ?? "",
    input.bodyDigest,
    input.actorContextDigest,
    input.actorContextHeader,
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
  input: InternalRequestSigningInput & {
    actor: TakosActorContext;
    secret: string;
  },
): Promise<{ headers: Record<string, string> }> {
  const actorContextHeader = encodeActorContext(input.actor);
  const actorContextDigest = await sha256Hex(actorContextHeader);
  const bodyDigest = await sha256Hex(input.body);
  const nonce = input.nonce ?? input.actor.requestId;
  const signature = await hmacSha256Hex(
    input.secret,
    canonicalInternalRequest({
      ...input,
      requestId: input.actor.requestId,
      nonce,
      bodyDigest,
      actorContextHeader,
      actorContextDigest,
    }),
  );
  return {
    headers: {
      [TAKOS_INTERNAL_ACTOR_HEADER]: actorContextHeader,
      [TAKOS_INTERNAL_ACTOR_DIGEST_HEADER]: actorContextDigest,
      [TAKOS_INTERNAL_BODY_DIGEST_HEADER]: bodyDigest,
      [TAKOS_INTERNAL_NONCE_HEADER]: nonce,
      [TAKOS_INTERNAL_REQUEST_ID_HEADER]: input.actor.requestId,
      [TAKOS_INTERNAL_TIMESTAMP_HEADER]: input.timestamp,
      [TAKOS_INTERNAL_SIGNATURE_HEADER]: signature,
      ...(input.caller ? { [TAKOS_INTERNAL_CALLER_HEADER]: input.caller } : {}),
      ...(input.audience
        ? { [TAKOS_INTERNAL_AUDIENCE_HEADER]: input.audience }
        : {}),
    },
  };
}

export async function verifyInternalRequestSignature(
  input: SignedInternalRequestInput & {
    secret: string;
    signature: string;
  },
): Promise<boolean> {
  const expectedSignature = await hmacSha256Hex(
    input.secret,
    canonicalInternalRequest(input),
  );
  return timingSafeEqualHex(expectedSignature, input.signature);
}

export async function verifySignedInternalRequestFromHeaders(
  input:
    & Omit<InternalRequestSigningInput, "timestamp">
    & {
      secret: string;
      headers: Headers | Record<string, string>;
      now?: () => Date;
      maxClockSkewMs?: number;
      expectedCaller?: string;
      expectedAudience?: string;
    },
): Promise<boolean> {
  const signature = readHeader(input.headers, TAKOS_INTERNAL_SIGNATURE_HEADER);
  const timestamp = readHeader(input.headers, TAKOS_INTERNAL_TIMESTAMP_HEADER);
  const requestId = readHeader(input.headers, TAKOS_INTERNAL_REQUEST_ID_HEADER);
  const nonce = readHeader(input.headers, TAKOS_INTERNAL_NONCE_HEADER);
  const caller = readHeader(input.headers, TAKOS_INTERNAL_CALLER_HEADER) ?? "";
  const audience = readHeader(input.headers, TAKOS_INTERNAL_AUDIENCE_HEADER) ??
    "";
  const bodyDigest = readHeader(
    input.headers,
    TAKOS_INTERNAL_BODY_DIGEST_HEADER,
  );
  const actorContextHeader = readHeader(
    input.headers,
    TAKOS_INTERNAL_ACTOR_HEADER,
  );
  const actorContextDigest = readHeader(
    input.headers,
    TAKOS_INTERNAL_ACTOR_DIGEST_HEADER,
  );
  if (
    !signature || !timestamp || !requestId || !nonce || !bodyDigest ||
    !actorContextHeader || !actorContextDigest
  ) {
    return false;
  }
  if (!timestampWithinSkew(timestamp, input)) return false;
  if (input.expectedCaller && caller !== input.expectedCaller) return false;
  if (input.expectedAudience && audience !== input.expectedAudience) {
    return false;
  }
  let actor: TakosActorContext;
  try {
    actor = decodeActorContext(actorContextHeader);
  } catch {
    return false;
  }
  if (actor.requestId !== requestId) return false;
  const actualActorDigest = await sha256Hex(actorContextHeader);
  if (!timingSafeEqualHex(actualActorDigest, actorContextDigest)) return false;
  const actualBodyDigest = await sha256Hex(input.body);
  if (!timingSafeEqualHex(actualBodyDigest, bodyDigest)) return false;
  return verifyInternalRequestSignature({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp,
    requestId,
    nonce,
    caller,
    audience,
    bodyDigest,
    actorContextHeader,
    actorContextDigest,
    secret: input.secret,
    signature,
  });
}

function timestampWithinSkew(
  timestamp: string,
  input: {
    readonly now?: () => Date;
    readonly maxClockSkewMs?: number;
  },
): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const maxClockSkewMs = input.maxClockSkewMs ??
    TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  if (!Number.isFinite(maxClockSkewMs)) return true;
  const now = (input.now?.() ?? new Date()).getTime();
  return Math.abs(now - parsed) <= maxClockSkewMs;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(message),
  );
  return toHex(signature);
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(value)),
  );
}

function readHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
