import { describe, expect, test } from "bun:test";

import { createGitWorker } from "./worker.ts";
import { makeEnv, seedFullRepo } from "./features/repos/testkit.ts";

const channels = [
  { name: "Smart HTTP", audience: "/git", scope: "source.git.smart_http.read", path: "/git/acme/widgets.git/info/refs?service=git-upload-pack" },
  { name: "hosting API", audience: "/api/v1", scope: "source.git.hosting.read", path: "/api/v1/repos" },
  { name: "MCP", audience: "/mcp", scope: "mcp.invoke", path: "/mcp" },
];

describe("Interface app context across invocation channels", () => {
  for (const channel of channels) {
    test(`${channel.name} accepts Capsule-only machine evidence and refuses foreign apps`, async () => {
      const handle = makeEnv();
      await seedFullRepo(handle, { ownerLogin: "acme", name: "widgets", visibility: "public" });
      const evidence: Record<string, unknown> = {
        capsule_id: "capsule_git",
        interface_id: "interface_git",
        interface_binding_id: "binding_git",
        interface_resolved_revision: 1,
      };
      let scope = channel.scope;
      const worker = createGitWorker(async () => Response.json({
        token_use: "interface_oauth", sub: "machine_principal",
        aud: `https://git.example${channel.audience}`, scope,
        takosumi: evidence,
      }));
      const invoke = (workspaceId: string | undefined, capsuleId: string | undefined = "capsule_git") =>
        worker.fetch(new Request(`https://git.example${channel.path}`, {
          method: channel.name === "MCP" ? "POST" : "GET",
          headers: { authorization: "Bearer taksrv_machine", "content-type": "application/json" },
          ...(channel.name === "MCP" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
        }), { ...handle.env, APP_WORKSPACE_ID: workspaceId, APP_CAPSULE_ID: capsuleId });
      // A machine capability needs no human app_role and no Workspace claim,
      // including during migration while the old deployment binding remains.
      expect((await invoke(undefined)).status).toBe(200);
      expect((await invoke("workspace_a")).status).toBe(200);
      const missing = { ...handle.env, APP_WORKSPACE_ID: undefined, APP_CAPSULE_ID: undefined };
      const missingResponse = await worker.fetch(new Request(`https://git.example${channel.path}`, {
        method: channel.name === "MCP" ? "POST" : "GET",
        headers: { authorization: "Bearer taksrv_machine", "content-type": "application/json" },
        ...(channel.name === "MCP" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
      }), missing);
      expect(missingResponse.status).toBe(503);
      evidence.workspace_id = "workspace_a";
      expect((await invoke("workspace_a")).status).toBe(200);
      evidence.capsule_id = "foreign_capsule";
      expect((await invoke("workspace_a")).status).toBe(401);
      evidence.capsule_id = "capsule_git";
      evidence.workspace_id = "foreign_workspace";
      expect((await invoke("workspace_a")).status).toBe(401);
      delete evidence.workspace_id;
      scope = "unrelated.permission";
      expect((await invoke(undefined)).status).toBe(401);
      scope = channel.scope;
      evidence.interface_resolved_revision = 0;
      expect((await invoke(undefined)).status).toBe(401);
    });
  }
});
