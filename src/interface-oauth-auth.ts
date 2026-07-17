const MAX_USERINFO_BYTES = 64 * 1024;
const MAX_INTERFACE_BEARER_LENGTH = 8_192;
const MAX_EVIDENCE_ID_LENGTH = 512;
const INTERFACE_TOKEN_PREFIX = "taksrv_";
const INTERFACE_PERMISSION_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u;

export interface InterfaceOAuthOptions {
  issuerUrl?: string;
  expectedAudience: string;
  expectedWorkspaceId?: string;
  expectedCapsuleId?: string;
  fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVIDENCE_ID_LENGTH &&
    value === value.trim() &&
    !/\s/u.test(value)
  );
}

function validPermission(value: unknown): value is string {
  return typeof value === "string" && INTERFACE_PERMISSION_PATTERN.test(value);
}

function userInfoEndpoint(issuerUrl?: string): URL | null {
  if (!issuerUrl?.trim()) return null;
  try {
    const issuer = new URL(issuerUrl);
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
    return new URL("/oauth/userinfo", issuer.origin);
  } catch {
    return null;
  }
}

function canonicalResourceUri(value: string): string | null {
  try {
    const resource = new URL(value);
    if (
      resource.protocol !== "https:" ||
      resource.username !== "" ||
      resource.password !== "" ||
      resource.search !== "" ||
      resource.hash !== ""
    ) {
      return null;
    }
    return resource.href;
  } catch {
    return null;
  }
}

/** Build an Interface audience only from an explicitly configured bare HTTPS origin. */
export function interfaceAudience(
  configuredOrigin: string | undefined,
  path: string,
): string {
  if (!configuredOrigin?.trim() || !path.startsWith("/")) return "";
  try {
    const origin = new URL(configuredOrigin.trim());
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      return "";
    }
    return new URL(path, origin).href;
  } catch {
    return "";
  }
}

function requestTargetsResource(
  request: Request,
  resourceUri: string,
): boolean {
  try {
    const requestUrl = new URL(request.url);
    const resourceUrl = new URL(resourceUri);
    const requestPath = requestUrl.pathname;
    const resourcePath = resourceUrl.pathname.replace(/\/$/u, "");
    return (
      requestUrl.origin === resourceUrl.origin &&
      (requestPath === resourcePath ||
        requestPath.startsWith(`${resourcePath}/`))
    );
  } catch {
    return false;
  }
}

export function hasValidInterfaceOAuthConfiguration(input: {
  issuerUrl?: string;
  audience?: string;
  workspaceId?: string;
  capsuleId?: string;
}): boolean {
  return (
    userInfoEndpoint(input.issuerUrl) !== null &&
    canonicalResourceUri(input.audience ?? "") !== null &&
    boundedId(input.workspaceId) &&
    boundedId(input.capsuleId)
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_USERINFO_BYTES) return null;

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_USERINFO_BYTES) {
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

/**
 * The proven identity behind an invocation-only Interface OAuth credential.
 *
 * `verifyInterfaceOAuthBearer` discards this and returns a boolean (the smart_http
 * scope gate needs nothing more). `verifyInterfaceOAuthCredential` surfaces the
 * evidence so per-repo ACL can resolve an app-local automation principal from the
 * SAME proven token — no new credential type, no second IdP.
 */
export type InterfaceCredential =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly scope: string;
      readonly interfaceId: string;
      readonly interfaceBindingId: string;
      readonly resolvedRevision: number;
    }
  | { readonly ok: false };

/**
 * Validate one invocation-only Takosumi Interface OAuth credential, returning the
 * proven InterfaceBinding evidence on success.
 *
 * Accounts revalidates the opaque token against current Core state before
 * UserInfo returns it active. The Capsule independently checks the exact
 * resource URI, permission, owning Workspace/Capsule, subject, and complete
 * InterfaceBinding evidence shape. It does not pin Interface ids or revisions
 * into static deployment configuration.
 */
export async function verifyInterfaceOAuthCredential(
  request: Request,
  token: string,
  expectedPermission: string,
  options: InterfaceOAuthOptions,
): Promise<InterfaceCredential> {
  const endpoint = userInfoEndpoint(options.issuerUrl);
  const expectedAudience = canonicalResourceUri(options.expectedAudience);
  const expectedWorkspaceId = options.expectedWorkspaceId?.trim();
  const expectedCapsuleId = options.expectedCapsuleId?.trim();
  if (
    !endpoint ||
    !expectedAudience ||
    !boundedId(expectedWorkspaceId) ||
    !boundedId(expectedCapsuleId) ||
    !validPermission(expectedPermission) ||
    !requestTargetsResource(request, expectedAudience) ||
    !token.startsWith(INTERFACE_TOKEN_PREFIX) ||
    token.length <= INTERFACE_TOKEN_PREFIX.length ||
    token.length > MAX_INTERFACE_BEARER_LENGTH ||
    token !== token.trim() ||
    /\s/u.test(token)
  ) {
    return { ok: false };
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });
    if (response.status !== 200) return { ok: false };

    const claims = await readBoundedJson(response);
    if (!isRecord(claims) || !isRecord(claims.takosumi)) return { ok: false };
    const evidence = claims.takosumi;
    const valid =
      claims.token_use === "interface_oauth" &&
      boundedId(claims.sub) &&
      claims.aud === expectedAudience &&
      claims.scope === expectedPermission &&
      evidence.workspace_id === expectedWorkspaceId &&
      evidence.capsule_id === expectedCapsuleId &&
      boundedId(evidence.interface_id) &&
      boundedId(evidence.interface_binding_id) &&
      Number.isSafeInteger(evidence.interface_resolved_revision) &&
      (evidence.interface_resolved_revision as number) > 0;
    if (!valid) return { ok: false };
    return {
      ok: true,
      subject: claims.sub as string,
      scope: claims.scope as string,
      interfaceId: evidence.interface_id as string,
      interfaceBindingId: evidence.interface_binding_id as string,
      resolvedRevision: evidence.interface_resolved_revision as number,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Boolean wrapper over {@link verifyInterfaceOAuthCredential}, kept as the exact
 * smart_http / hosting-read scope gate the worker and forge-api already use.
 */
export async function verifyInterfaceOAuthBearer(
  request: Request,
  token: string,
  expectedPermission: string,
  options: InterfaceOAuthOptions,
): Promise<boolean> {
  return (
    await verifyInterfaceOAuthCredential(
      request,
      token,
      expectedPermission,
      options,
    )
  ).ok;
}
