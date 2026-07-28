import { afterEach, expect, test } from "bun:test";

import { initTheme } from "./theme.ts";

const realMatchMedia = globalThis.matchMedia;

afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
});

test("theme initialization replaces its listener and exposes final cleanup", () => {
  const media = new EventTarget() as MediaQueryList;
  Object.defineProperties(media, {
    matches: { value: false },
    media: { value: "(prefers-color-scheme: dark)" },
  });
  let added = 0;
  let removed = 0;
  const add = media.addEventListener.bind(media);
  const remove = media.removeEventListener.bind(media);
  media.addEventListener = ((...args: Parameters<MediaQueryList["addEventListener"]>) => {
    added += 1;
    return add(...args);
  }) as MediaQueryList["addEventListener"];
  media.removeEventListener = ((...args: Parameters<MediaQueryList["removeEventListener"]>) => {
    removed += 1;
    return remove(...args);
  }) as MediaQueryList["removeEventListener"];
  globalThis.matchMedia = (() => media) as typeof matchMedia;

  const disposeFirst = initTheme();
  const disposeSecond = initTheme();
  disposeFirst();
  disposeSecond();

  expect({ added, removed }).toEqual({ added: 2, removed: 2 });
});
