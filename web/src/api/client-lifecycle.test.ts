import { afterEach, expect, test } from "bun:test";

import { api } from "./client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a completed request detaches its caller abort listener", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const signal = new EventTarget() as AbortSignal;
  Object.defineProperty(signal, "aborted", { value: false });
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    ...args: Parameters<AbortSignal["addEventListener"]>
  ) => {
    added += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    removed += 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  await api.get("/api/v1/ping", undefined, signal);

  expect({ added, removed }).toEqual({ added: 1, removed: 1 });
});

test("expired browser sessions navigate to login with the current return path", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const navigations: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      pathname: "/repos/acme/widgets",
      search: "?tab=code",
      assign: (url: string) => navigations.push(url),
    },
  });
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: {
          code: "session_expired",
          message: "Sign in again to continue.",
        },
      },
      { status: 401 },
    )) as typeof fetch;
  try {
    await expect(api.get("/api/auth/session")).rejects.toMatchObject({
      status: 401,
      code: "session_expired",
    });
    expect(navigations).toEqual([
      "/api/auth/login?return_to=%2Frepos%2Facme%2Fwidgets%3Ftab%3Dcode",
    ]);
  } finally {
    if (originalLocation)
      Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
