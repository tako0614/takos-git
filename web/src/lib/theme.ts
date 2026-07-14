/**
 * Theme controller. Resolves `system | light | dark` to a CONCRETE `data-theme`
 * on <html> so the CSS (`styles.css`) and the Tailwind `dark:` variant have a
 * single, unambiguous signal. Persisted in localStorage; follows the OS while
 * set to `system`.
 */
import { createSignal } from "solid-js";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "takos-git:theme";

function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* private mode / no storage */
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

const [pref, setPrefSignal] = createSignal<ThemePref>(readPref());
const [resolved, setResolved] = createSignal<ResolvedTheme>(resolve(readPref()));

function apply(): void {
  const next = resolve(pref());
  setResolved(next);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", next);
  }
}

/** Call once at boot (before/at first render) to stamp the initial theme. */
export function initTheme(): void {
  apply();
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (pref() === "system") apply();
    });
  }
}

export function setThemePref(next: ThemePref): void {
  setPrefSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply();
}

export function themePref(): ThemePref {
  return pref();
}

export function resolvedTheme(): ResolvedTheme {
  return resolved();
}

/** Cycle light → dark → system for a single toggle button. */
export function cycleTheme(): void {
  const order: ThemePref[] = ["light", "dark", "system"];
  const idx = order.indexOf(pref());
  setThemePref(order[(idx + 1) % order.length]);
}
