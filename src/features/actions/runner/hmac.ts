/**
 * Run-scoped HMAC bearer for the `/internal/actions/*` trust boundary.
 *
 * This is a SEPARATE trust boundary from Interface OAuth / browser sessions: the
 * container authenticates its checkout/logs/artifacts callbacks with a token
 * minted per run from `ACTIONS_RUNNER_SECRET`. The token binds `runId` + `jobId`
 * so a leaked token cannot act for another run. Verification is constant-time and
 * fail-closed (no secret ⇒ no valid token).
 *
 * Token form: `<payloadB64Url>.<sigB64Url>` where payload = `{runId,jobId,exp}`.
 */

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function unb64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "===".slice((padded.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export interface RunnerTokenClaims {
  readonly runId: string;
  readonly jobId: string;
  /** Absolute expiry (epoch ms). */
  readonly exp: number;
}

/** Mint a run-scoped runner token valid for `ttlMs` (default 2h). */
export async function mintRunnerToken(
  secret: string,
  claims: { runId: string; jobId: string },
  now: number,
  ttlMs = 2 * 60 * 60 * 1000,
): Promise<string> {
  const payload: RunnerTokenClaims = { runId: claims.runId, jobId: claims.jobId, exp: now + ttlMs };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64url(new TextEncoder().encode(payloadJson));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)),
  );
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Verify a runner token against `secret`. Returns the claims on success, or null
 * on any tamper / expiry / format error. Fail-closed: an empty secret rejects.
 */
export async function verifyRunnerToken(
  secret: string | undefined,
  token: string,
  now: number,
): Promise<RunnerTokenClaims | null> {
  if (!secret || secret.trim().length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const expected = b64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64))),
    );
    if (!timingSafeEqual(sigB64, expected)) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(payloadB64))) as RunnerTokenClaims;
    if (
      typeof payload.runId !== "string" ||
      typeof payload.jobId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < now
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Extract a Bearer token from an Authorization header, or null. */
export function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") return null;
  return value;
}
