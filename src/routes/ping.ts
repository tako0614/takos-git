/**
 * The Phase-1 trivial route. Registering it here (a side-effect import) is the
 * model every later feature follows: a feature module declares its routes and
 * calls `routes.register(...)`, and worker.ts gains exactly one import line — it
 * never grows per-feature control flow.
 */

import { routes, type Route } from "../router.ts";

export const pingRoute: Route = {
  method: "GET",
  path: "/api/v1/ping",
  auth: "public",
  handler: () =>
    new Response(
      JSON.stringify({ service: "takos-git", api: "v1", ok: true }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    ),
};

routes.register(pingRoute);
