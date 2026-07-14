/**
 * Secret handling for webhooks.
 *
 * Two independent concerns:
 *
 * 1. **At-rest encryption** of the per-webhook HMAC secret (`webhooks.secret_enc`).
 *    The secret is AES-GCM sealed with a key derived from a `takos-git` worker
 *    secret (env, NOT a Takos binding) so the plaintext never sits in D1. The
 *    ciphertext column is never returned by any read API.
 *
 * 2. **Delivery signing.** Each delivery body is signed HMAC-SHA256 with the
 *    webhook's (decrypted) secret. This is a documented takos-git scheme, NOT
 *    GitHub wire-compat: the header is `X-Takos-Git-Signature-256: sha256=<hex>`.
 */

import type { RouterEnv } from "../../router.ts";

/**
 * The env-provided key material used to seal webhook secrets. A dedicated
 * `WEBHOOK_SECRET_KEY` worker secret is preferred; `APP_SESSION_SECRET` is the
 * fallback so a single-secret deploy still gets at-rest encryption. Returns null
 * when neither is configured (callers then reject secret storage, fail-closed).
 */
export function webhookEncryptionKey(env: RouterEnv): string | null {
  const bag = env as unknown as Record<string, unknown>;
  const dedicated = bag.WEBHOOK_SECRET_KEY;
  if (typeof dedicated === "string" && dedicated.trim().length > 0) {
    return dedicated;
  }
  const session = bag.APP_SESSION_SECRET;
  if (typeof session === "string" && session.trim().length > 0) return session;
  return null;
}

function toBytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unb64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-GCM seal `plain` → `"<ivB64>.<ctB64>"`. */
export async function encryptSecret(
  plain: string,
  keyMaterial: string,
): Promise<string> {
  const key = await aesKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toBytes(plain),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ciphertext))}`;
}

/** Reverse {@link encryptSecret}. Returns null on any tamper/format error. */
export async function decryptSecret(
  sealed: string,
  keyMaterial: string,
): Promise<string | null> {
  const [ivPart, ctPart, extra] = sealed.split(".");
  if (!ivPart || !ctPart || extra !== undefined) return null;
  try {
    const key = await aesKey(keyMaterial);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivPart) },
      key,
      unb64(ctPart),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** HMAC-SHA256 the request body with the webhook secret → lowercase hex. */
export async function signPayload(
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, toBytes(body));
  return hex(new Uint8Array(signature));
}

/** Header name carrying the `sha256=<hex>` delivery signature. */
export const SIGNATURE_HEADER = "x-takos-git-signature-256";
export const EVENT_HEADER = "x-takos-git-event";
export const DELIVERY_HEADER = "x-takos-git-delivery";
