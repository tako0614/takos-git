const SESSION_COOKIE = "takos_git_session";
const STATE_COOKIE = "takos_git_oauth_state";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const STATE_MAX_AGE_SECONDS = 10 * 60;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_COOKIE_VALUE_BYTES = 8 * 1024;
const MAX_AUTHORIZATION_CODE_LENGTH = 4 * 1024;
const MAX_STATE_LENGTH = 512;
const MAX_ACCESS_TOKEN_LENGTH = 8 * 1024;
const MAX_PROFILE_FIELD_LENGTH = 512;
const MAX_WORKSPACE_MEMBERSHIPS = 256;

export interface BrowserAuthEnv {
  APP_URL?: string;
  OIDC_ISSUER_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  APP_SESSION_SECRET?: string;
  APP_WORKSPACE_ID?: string;
}

export interface BrowserSession {
  readonly subject: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly workspaceIds: readonly string[];
  readonly expiresAt: number;
}

interface OAuthState {
  readonly state: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}

interface StoredSession {
  readonly subject: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly workspaceIds: readonly string[];
  readonly expiresAt: number;
}

export type OAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function configuredValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function issuerBase(value: string | undefined): URL | null {
  const configured = configuredValue(value);
  if (!configured) return null;
  try {
    const issuer = new URL(configured);
    if (
      issuer.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.pathname !== "/" ||
      issuer.search !== "" ||
      issuer.hash !== ""
    ) {
      return null;
    }
    return issuer;
  } catch {
    return null;
  }
}

function endpoint(issuer: URL, path: string): URL {
  return new URL(path, issuer.origin);
}

function publicOrigin(value: string | undefined): URL | null {
  const configured = configuredValue(value);
  if (!configured) return null;
  try {
    const origin = new URL(configured);
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

export function browserAuthMissing(env: BrowserAuthEnv): readonly string[] {
  const missing: string[] = [];
  if (!publicOrigin(env.APP_URL)) missing.push("APP_URL");
  if (!issuerBase(env.OIDC_ISSUER_URL)) missing.push("OIDC_ISSUER_URL");
  const clientId = configuredValue(env.OIDC_CLIENT_ID);
  if (!clientId || clientId.length > 512) missing.push("OIDC_CLIENT_ID");
  const sessionSecret = configuredValue(env.APP_SESSION_SECRET);
  if (!sessionSecret || sessionSecret.length < 32) {
    missing.push("APP_SESSION_SECRET");
  }
  if (!configuredValue(env.APP_WORKSPACE_ID)) {
    missing.push("APP_WORKSPACE_ID");
  }
  return missing;
}

export function browserAuthConfigured(env: BrowserAuthEnv): boolean {
  return browserAuthMissing(env).length === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function parseBase64UrlJson<T>(value: string): T | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(signature));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (
    let index = 0;
    index < leftBytes.length && index < rightBytes.length;
    index += 1
  ) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function seal(
  value: unknown,
  secret: string,
  purpose: "state" | "session",
): Promise<string> {
  const payload = base64UrlJson(value);
  return `${payload}.${await sign(`${purpose}.${payload}`, secret)}`;
}

async function unseal<T>(
  token: string,
  secret: string,
  purpose: "state" | "session",
): Promise<T | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = await sign(`${purpose}.${payload}`, secret);
  if (!(await timingSafeEqual(signature, expected))) return null;
  return parseBase64UrlJson<T>(payload);
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=") || null;
  }
  return null;
}

function cookieHeader(
  request: Request,
  name: string,
  value: string,
  maxAge: number,
): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(request: Request, name: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || hasControlCharacter(value)) return "/";
  try {
    const base = "https://takos-git.invalid";
    const resolved = new URL(value, base);
    return resolved.origin === base
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function callbackUrl(env: BrowserAuthEnv): string {
  const origin = publicOrigin(env.APP_URL);
  return origin ? new URL("/api/auth/callback", origin).href : "";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES) {
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_OAUTH_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function normalizeWorkspaceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const workspaceIds = new Set<string>();
  for (const entry of value) {
    const candidate =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).workspace_id
          : null;
    if (
      typeof candidate !== "string" ||
      candidate.length > MAX_PROFILE_FIELD_LENGTH ||
      candidate.trim() === "" ||
      /\s/u.test(candidate)
    ) {
      continue;
    }
    workspaceIds.add(candidate);
    if (workspaceIds.size >= MAX_WORKSPACE_MEMBERSHIPS) break;
  }
  return [...workspaceIds];
}

function optionalProfileField(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_PROFILE_FIELD_LENGTH
    ? value
    : null;
}

async function exchangeCode(
  env: BrowserAuthEnv,
  code: string,
  codeVerifier: string,
  fetchImpl: OAuthFetch,
): Promise<string | null> {
  const issuer = issuerBase(env.OIDC_ISSUER_URL);
  const clientId = configuredValue(env.OIDC_CLIENT_ID);
  if (!issuer || !clientId) return null;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: callbackUrl(env),
    code_verifier: codeVerifier,
  });
  const clientSecret = configuredValue(env.OIDC_CLIENT_SECRET);
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetchImpl(endpoint(issuer, "/oauth/token"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "manual",
  });
  if (response.status !== 200) return null;
  const payload = await readBoundedJson(response);
  if (!payload || typeof payload !== "object") return null;
  const accessToken = (payload as Record<string, unknown>).access_token;
  return typeof accessToken === "string" &&
    accessToken.length <= MAX_ACCESS_TOKEN_LENGTH &&
    accessToken.trim() === accessToken &&
    !/\s/u.test(accessToken)
    ? accessToken
    : null;
}

async function fetchUserInfo(
  env: BrowserAuthEnv,
  accessToken: string,
  fetchImpl: OAuthFetch,
): Promise<Omit<StoredSession, "expiresAt"> | null> {
  const issuer = issuerBase(env.OIDC_ISSUER_URL);
  if (!issuer) return null;
  const response = await fetchImpl(endpoint(issuer, "/oauth/userinfo"), {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    redirect: "manual",
  });
  if (response.status !== 200) return null;
  const payload = await readBoundedJson(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const claims = payload as Record<string, unknown>;
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (subject === "" || subject.length > 512 || /\s/u.test(subject))
    return null;
  const workspaceIds = normalizeWorkspaceIds(claims.workspace_memberships);
  const takosumi = claims.takosumi;
  if (takosumi && typeof takosumi === "object" && !Array.isArray(takosumi)) {
    const workspaceId = (takosumi as Record<string, unknown>).workspace_id;
    if (
      typeof workspaceId === "string" &&
      workspaceId.length <= MAX_PROFILE_FIELD_LENGTH &&
      workspaceId.trim() !== "" &&
      !/\s/u.test(workspaceId) &&
      !workspaceIds.includes(workspaceId) &&
      workspaceIds.length < MAX_WORKSPACE_MEMBERSHIPS
    ) {
      workspaceIds.push(workspaceId);
    }
  }
  return {
    subject,
    name: optionalProfileField(claims.name),
    email: optionalProfileField(claims.email),
    workspaceIds,
  };
}

export async function readBrowserSession(
  request: Request,
  env: BrowserAuthEnv,
): Promise<BrowserSession | null> {
  const sessionSecret = configuredValue(env.APP_SESSION_SECRET);
  const expectedWorkspaceId = configuredValue(env.APP_WORKSPACE_ID);
  if (!sessionSecret || !expectedWorkspaceId) return null;
  const raw = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!raw || raw.length > MAX_COOKIE_VALUE_BYTES) return null;
  const session = await unseal<StoredSession>(raw, sessionSecret, "session");
  const now = Math.floor(Date.now() / 1000);
  if (
    !session ||
    typeof session.subject !== "string" ||
    session.subject === "" ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= now ||
    !Array.isArray(session.workspaceIds) ||
    !session.workspaceIds.includes(expectedWorkspaceId)
  ) {
    return null;
  }
  return session;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function authUnavailable(env: BrowserAuthEnv): Response {
  return json(
    { error: "browser_auth_unconfigured", missing: browserAuthMissing(env) },
    503,
  );
}

export async function handleBrowserAuth(
  request: Request,
  env: BrowserAuthEnv,
  fetchImpl: OAuthFetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const session = await readBrowserSession(request, env);
    return json(
      session
        ? {
            authenticated: true,
            user: {
              subject: session.subject,
              name: session.name,
              email: session.email,
            },
          }
        : { authenticated: false, configured: browserAuthConfigured(env) },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/auth/login") {
    if (!browserAuthConfigured(env)) return authUnavailable(env);
    const issuer = issuerBase(env.OIDC_ISSUER_URL) as URL;
    const clientId = configuredValue(env.OIDC_CLIENT_ID) as string;
    const sessionSecret = configuredValue(env.APP_SESSION_SECRET) as string;
    const codeVerifier = randomToken();
    const state: OAuthState = {
      state: randomToken(),
      codeVerifier,
      returnTo: safeReturnTo(url.searchParams.get("return_to")),
      expiresAt: Math.floor(Date.now() / 1000) + STATE_MAX_AGE_SECONDS,
    };
    const authorize = endpoint(issuer, "/oauth/authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(env));
    authorize.searchParams.set("scope", "openid profile email");
    authorize.searchParams.set("state", state.state);
    authorize.searchParams.set(
      "code_challenge",
      await sha256Base64Url(codeVerifier),
    );
    authorize.searchParams.set("code_challenge_method", "S256");
    return new Response(null, {
      status: 302,
      headers: {
        location: authorize.href,
        "set-cookie": cookieHeader(
          request,
          STATE_COOKIE,
          await seal(state, sessionSecret, "state"),
          STATE_MAX_AGE_SECONDS,
        ),
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/callback") {
    if (!browserAuthConfigured(env)) return authUnavailable(env);
    const sessionSecret = configuredValue(env.APP_SESSION_SECRET) as string;
    const stateCookie = parseCookie(
      request.headers.get("cookie"),
      STATE_COOKIE,
    );
    const state = stateCookie
      ? stateCookie.length <= MAX_COOKIE_VALUE_BYTES
        ? await unseal<OAuthState>(stateCookie, sessionSecret, "state")
        : null
      : null;
    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (
      !state ||
      !returnedState ||
      !code ||
      returnedState.length > MAX_STATE_LENGTH ||
      code.length > MAX_AUTHORIZATION_CODE_LENGTH ||
      typeof state.state !== "string" ||
      typeof state.codeVerifier !== "string" ||
      !(await timingSafeEqual(state.state, returnedState)) ||
      state.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return json({ error: "invalid_oauth_state" }, 400, {
        "set-cookie": clearCookie(request, STATE_COOKIE),
      });
    }
    const accessToken = await exchangeCode(
      env,
      code,
      state.codeVerifier,
      fetchImpl,
    );
    const user = accessToken
      ? await fetchUserInfo(env, accessToken, fetchImpl)
      : null;
    const expectedWorkspaceId = configuredValue(env.APP_WORKSPACE_ID) as string;
    if (!user || !user.workspaceIds.includes(expectedWorkspaceId)) {
      return json({ error: "workspace_membership_required" }, 403, {
        "set-cookie": clearCookie(request, STATE_COOKIE),
      });
    }
    const session = await seal(
      {
        ...user,
        // The installed Workspace is the only authorization fact this local
        // session needs. Do not retain the user's unrelated memberships.
        workspaceIds: [expectedWorkspaceId],
        expiresAt: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
      } satisfies StoredSession,
      sessionSecret,
      "session",
    );
    const headers = new Headers({
      location: safeReturnTo(state.returnTo),
      "cache-control": "no-store",
    });
    headers.append("set-cookie", clearCookie(request, STATE_COOKIE));
    headers.append(
      "set-cookie",
      cookieHeader(request, SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS),
    );
    return new Response(null, { status: 302, headers });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return json({ error: "origin_forbidden" }, 403);
    }
    return json({ success: true }, 200, {
      "set-cookie": clearCookie(request, SESSION_COOKIE),
    });
  }

  return json({ error: "method_not_allowed" }, 405, {
    allow: url.pathname === "/api/auth/logout" ? "POST" : "GET",
  });
}
