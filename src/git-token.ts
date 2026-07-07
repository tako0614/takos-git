/**
 * Scoped git access token — same wire format as the takos-storage object-store
 * token (`takstor_<b64url(payload)>.<b64url(hmac)>`), with a git-hosting
 * audience. Takosumi mints one per consumer at bind time, bounded to a repo
 * prefix (`pfx`) and a verb set (`cap`: `r` = read/clone, `w` = push). The
 * standalone takos-git Worker verifies it on every request.
 *
 * Dependency-free (Web Crypto) so the exact format can be re-minted on the
 * Takosumi side.
 */

export type GitTokenVerb = "r" | "w";

export interface GitTokenPayload {
  readonly v: 1;
  /** Workspace (space) id the grant belongs to. */
  readonly ws: string;
  /** Consumer installation id the token was minted for. */
  readonly sub: string;
  /** Repo prefix the token is scoped to (non-empty). */
  readonly pfx: string;
  readonly cap: readonly GitTokenVerb[];
  /** Audience — always the git-hosting publication name. */
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export type GitTokenVerifyResult =
  | { readonly ok: true; readonly payload: GitTokenPayload }
  | {
      readonly ok: false;
      readonly reason: "format" | "signature" | "payload" | "version" | "expired";
    };

const TOKEN_PREFIX = "takstor_";
const AUDIENCE = "takos.git.hosting";

export { AUDIENCE as GIT_TOKEN_AUDIENCE, TOKEN_PREFIX as GIT_TOKEN_PREFIX };

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintGitToken(
  signingKey: string,
  payload: GitTokenPayload,
): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importHmacKey(signingKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `${TOKEN_PREFIX}${body}.${b64urlEncode(signature)}`;
}

export async function verifyGitToken(
  signingKey: string,
  token: string,
  nowSeconds: number,
): Promise<GitTokenVerifyResult> {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "format" };
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) return { ok: false, reason: "format" };
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);

  const key = await importHmacKey(signingKey);
  let signatureOk = false;
  try {
    signatureOk = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(signature),
      new TextEncoder().encode(body),
    );
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!signatureOk) return { ok: false, reason: "signature" };

  let payload: GitTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as GitTokenPayload;
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (payload.v !== 1 || payload.aud !== AUDIENCE || !Array.isArray(payload.cap)) {
    return { ok: false, reason: "version" };
  }
  if (typeof payload.pfx !== "string" || payload.pfx.length === 0) {
    return { ok: false, reason: "version" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

/** True when the token permits `verb` on `repo` (repo must be within the token prefix). */
export function gitTokenAllows(
  payload: GitTokenPayload,
  verb: GitTokenVerb,
  repo: string,
): boolean {
  if (!payload.cap.includes(verb)) return false;
  if (!payload.pfx) return false;
  return repo === payload.pfx || repo.startsWith(`${payload.pfx}/`);
}
