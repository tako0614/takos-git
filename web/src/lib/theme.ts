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
let disposeSystemListener: (() => void) | null = null;

function apply(): void {
  const next = resolve(pref());
  setResolved(next);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", next);
  }
}

/**
 * Stamp the initial theme and follow the OS preference.
 *
 * Re-initialization first removes the previous listener (important for dev/HMR)
 * and the returned disposer releases the current one at page teardown.
 */
export function initTheme(): () => void {
  apply();
  disposeSystemListener?.();
  disposeSystemListener = null;
  if (typeof matchMedia === "function") {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      if (pref() === "system") apply();
    };
    media.addEventListener("change", onChange);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      media.removeEventListener("change", onChange);
      if (disposeSystemListener === dispose) disposeSystemListener = null;
    };
    disposeSystemListener = dispose;
    return dispose;
  }
  return () => {};
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
