/**
 * Shared test harness for the issues feature. Registers BOTH the repos feature
 * (to create repos / grant collaborator roles) and the issues feature into one
 * registry, and provides a token table + repo setup. Imported only by *.test.ts.
 */

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerIssuesRoutes } from "./routes.ts";
import { interfaceUserInfoFetch, jsonRequest } from "../repos/testkit.ts";

/** subject → capped Interface-OAuth token, one scope each. */
export const tokens = interfaceUserInfoFetch({
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_alice_r: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_bob_w: { scope: "source.git.hosting.write", subject: "sub-bob" },
  taksrv_bob_r: { scope: "source.git.hosting.read", subject: "sub-bob" },
  taksrv_bob_a: { scope: "source.git.hosting.admin", subject: "sub-bob" },
  taksrv_carol_w: { scope: "source.git.hosting.write", subject: "sub-carol" },
  taksrv_carol_r: { scope: "source.git.hosting.read", subject: "sub-carol" },
  taksrv_dave_w: { scope: "source.git.hosting.write", subject: "sub-dave" },
});

export function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerRepoRoutes(reg);
  registerIssuesRoutes(reg);
  return reg;
}

export async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: tokens });
  if (!res) {
    const url = new URL(request.url);
    throw new Error(`route not handled: ${request.method} ${url.pathname}`);
  }
  return res;
}

export interface SetupOpts {
  readonly visibility?: "public" | "private";
  /** extra collaborators to grant, subject → role. */
  readonly grants?: Readonly<Record<string, string>>;
}

/**
 * Create `alice/web` owned by alice (owner role) and grant bob=writer,
 * carol=reader (+ any extra grants). Returns nothing; callers address the repo by
 * path.
 */
export async function setupRepo(
  reg: RouteRegistry,
  env: RouterEnv,
  opts: SetupOpts = {},
): Promise<void> {
  const visibility = opts.visibility ?? "public";
  await dispatch(
    reg,
    jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility }, "taksrv_alice_w"),
    env,
  );
  const grants: Record<string, string> = {
    "sub-bob": "writer",
    "sub-carol": "reader",
    ...(opts.grants ?? {}),
  };
  for (const [subject, role] of Object.entries(grants)) {
    await dispatch(
      reg,
      jsonRequest("PUT", `/api/v1/repos/alice/web/collaborators/${subject}`, { role }, "taksrv_alice_a"),
      env,
    );
  }
}
