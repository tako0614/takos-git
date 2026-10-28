import { describe, expect, test } from "bun:test";

import {
  hasValidInterfaceOAuthConfiguration,
  interfaceAudience,
  verifyInterfaceOAuthBearer,
} from "./interface-oauth-auth.ts";

const TOKEN = "taksrv_git_test_token";
const PERMISSION = "source.git.smart_http.read";
const validClaims = {
  token_use: "interface_oauth",
  sub: "principal_git",
  aud: "https://git.example/git",
  scope: PERMISSION,
  takosumi: {
    workspace_id: "workspace_a",
    capsule_id: "capsule_git",
    interface_id: "interface_git_http",
    interface_binding_id: "binding_a",
    interface_resolved_revision: 5,
  },
};

function verify(
  body: unknown,
  overrides: {
    token?: string;
    permission?: string;
    requestUrl?: string;
    workspaceId?: string | null;
    capsuleId?: string;
    status?: number;
  } = {},
): Promise<boolean> {
  return verifyInterfaceOAuthBearer(
    new Request(
      overrides.requestUrl ??
        "https://git.example/git/acme/widgets.git/info/refs",
    ),
    overrides.token ?? TOKEN,
    overrides.permission ?? PERMISSION,
    {
      issuerUrl: "https://accounts.example/",
      expectedAudience: "https://git.example/git",
      expectedWorkspaceId: overrides.workspaceId === null ? undefined : overrides.workspaceId ?? "workspace_a",
      expectedCapsuleId: overrides.capsuleId ?? "capsule_git",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://accounts.example/oauth/userinfo");
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${overrides.token ?? TOKEN}`,
        );
        return Response.json(body, { status: overrides.status ?? 200 });
      },
    },
  );
}

describe("Interface OAuth verifier", () => {
  test("builds audiences only from an explicit bare HTTPS origin", () => {
    expect(interfaceAudience("https://git.example/", "/git")).toBe(
      "https://git.example/git",
    );
    expect(interfaceAudience("https://git.example/nested", "/git")).toBe("");
    expect(interfaceAudience("https://user@git.example", "/git")).toBe("");
    expect(interfaceAudience("http://git.example", "/git")).toBe("");
    expect(interfaceAudience(undefined, "/git")).toBe("");
    expect(
      interfaceAudience(
        undefined,
        "/git",
        "https://git.example/git/acme/widgets.git/info/refs?service=git-upload-pack",
      ),
    ).toBe("https://git.example/git");
  });

  test("accepts exact audience, permission, owner, Binding, and revision evidence", async () => {
    expect(await verify(validClaims)).toBe(true);
  });

  test("rejects owner evidence without an independently configured expected Capsule", async () => {
    expect(
      await verifyInterfaceOAuthBearer(
        new Request("https://git.example/git/acme/widgets.git/info/refs"),
        TOKEN,
        PERMISSION,
        {
          issuerUrl: "https://accounts.example/",
          expectedAudience: "https://git.example/git",
          fetchImpl: async () => Response.json(validClaims),
        },
      ),
    ).toBe(false);
  });

  test("Capsule-only configuration is valid while an absent expected Capsule fails closed", () => {
    const base = { issuerUrl: "https://accounts.example", audience: "https://git.example/git" };
    expect(hasValidInterfaceOAuthConfiguration({ ...base, capsuleId: "capsule_git" })).toBe(true);
    expect(hasValidInterfaceOAuthConfiguration(base)).toBe(false);
    expect(hasValidInterfaceOAuthConfiguration({ ...base, workspaceId: "workspace_a" })).toBe(false);
  });

  test("workspace-less machine evidence works with both new and compatibility config without an app role", async () => {
    const { workspace_id, ...capsuleEvidence } = validClaims.takosumi;
    const claims = { ...validClaims, takosumi: capsuleEvidence };
    expect(await verify(claims, { workspaceId: null })).toBe(true);
    expect(await verify(claims)).toBe(true);
    expect(await verify({ ...claims, takosumi: { ...capsuleEvidence, capsule_id: "foreign_capsule" } })).toBe(false);
    expect(await verify(validClaims, { workspaceId: null })).toBe(true);
  });

  for (const workspace_id of [null, "", "has space", 1]) {
    test(`rejects malformed optional legacy workspace claim ${JSON.stringify(workspace_id)}`, async () => {
      expect(await verify({ ...validClaims, takosumi: { ...validClaims.takosumi, workspace_id } }, { workspaceId: null })).toBe(false);
    });
  }

  test("rejects mismatched or incomplete authorization evidence", async () => {
    expect(await verify({ ...validClaims, sub: "" })).toBe(false);
    expect(
      await verify({ ...validClaims, aud: "https://git.example/mcp" }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        scope: "source.git.smart_http.write",
      }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        takosumi: {
          ...validClaims.takosumi,
          workspace_id: "workspace_b",
        },
      }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        takosumi: { ...validClaims.takosumi, capsule_id: "capsule_other" },
      }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        takosumi: {
          ...validClaims.takosumi,
          interface_id: "",
        },
      }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        takosumi: {
          ...validClaims.takosumi,
          interface_resolved_revision: 0,
        },
      }),
    ).toBe(false);
    expect(
      await verify({
        ...validClaims,
        scope: `${PERMISSION} source.git.smart_http.write`,
      }),
    ).toBe(false);
  });

  test("rejects non-Interface tokens, unrelated resources, missing owner config, and non-200 UserInfo", async () => {
    expect(await verify(validClaims, { token: "takat_delegated" })).toBe(false);
    expect(
      await verify(validClaims, { requestUrl: "https://git.example/mcp" }),
    ).toBe(false);
    expect(
      await verify(validClaims, {
        requestUrl: "https://other.example/git/acme/widgets.git/info/refs",
      }),
    ).toBe(false);
    expect(await verify(validClaims, { workspaceId: "" })).toBe(false);
    expect(await verify(validClaims, { capsuleId: "" })).toBe(false);
    expect(await verify(validClaims, { status: 302 })).toBe(false);
  });

  test("rejects a non-origin issuer before UserInfo lookup", async () => {
    let called = false;
    expect(
      await verifyInterfaceOAuthBearer(
        new Request("https://git.example/git/acme/widgets.git/info/refs"),
        TOKEN,
        PERMISSION,
        {
          issuerUrl: "https://accounts.example/tenant",
          expectedAudience: "https://git.example/git",
          expectedWorkspaceId: "workspace_a",
          expectedCapsuleId: "capsule_git",
          fetchImpl: async () => {
            called = true;
            return Response.json(validClaims);
          },
        },
      ),
    ).toBe(false);
    expect(called).toBe(false);
  });
});
