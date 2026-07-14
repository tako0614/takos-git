/**
 * Toast store — a module-level SolidJS singleton (ported from takos/web,
 * decoupled from the Takos shell). `useToast()` exposes `showToast` +
 * lifecycle; `<ToastHost>` (mounted once in AppShell) renders the stack.
 */
import { createSignal } from "solid-js";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  readonly id: string;
  readonly type: ToastKind;
  readonly message: string;
}

const DEFAULT_DURATION_MS = 4000;
const MAX_TOASTS = 4;

const [toasts, setToasts] = createSignal<Toast[]>([]);

interface TimerState {
  handle: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remaining: number;
}

const timers = new Map<string, TimerState>();

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer?.handle != null) clearTimeout(timer.handle);
  timers.delete(id);
}

function dismissToast(id: string): void {
  clearTimer(id);
  setToasts((prev) => prev.filter((toast) => toast.id !== id));
}

function scheduleDismiss(id: string, ms: number): void {
  clearTimer(id);
  const handle = setTimeout(() => dismissToast(id), ms);
  timers.set(id, { handle, startedAt: Date.now(), remaining: ms });
}

function pauseToast(id: string): void {
  const timer = timers.get(id);
  if (!timer || timer.handle == null) return;
  clearTimeout(timer.handle);
  const elapsed = Date.now() - timer.startedAt;
  timers.set(id, {
    handle: null,
    startedAt: timer.startedAt,
    remaining: Math.max(0, timer.remaining - elapsed),
  });
}

function resumeToast(id: string): void {
  const timer = timers.get(id);
  if (!timer || timer.handle != null) return;
  scheduleDismiss(id, timer.remaining > 0 ? timer.remaining : DEFAULT_DURATION_MS);
}

function showToast(type: ToastKind, message: string): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setToasts((prev) => {
    const next = [...prev, { id, type, message }];
    while (next.length > MAX_TOASTS) {
      const removed = next.shift();
      if (removed) clearTimer(removed.id);
    }
    return next;
  });
  scheduleDismiss(id, DEFAULT_DURATION_MS);
  return id;
}

export function useToast() {
  return {
    get toasts(): Toast[] {
      return toasts();
    },
    showToast,
    dismissToast,
    pauseToast,
    resumeToast,
    /** Convenience helpers. */
    success: (message: string) => showToast("success", message),
    error: (message: string) => showToast("error", message),
    info: (message: string) => showToast("info", message),
    warning: (message: string) => showToast("warning", message),
  };
}
