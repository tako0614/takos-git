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
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  await api.get("/api/v1/ping", undefined, signal);

  expect({ added, removed }).toEqual({ added: 1, removed: 1 });
});
