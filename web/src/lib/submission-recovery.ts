import { createSignal } from "solid-js";
import { ApiError } from "../api/client.ts";

type SubmissionState<T> = { readonly attempt: T; readonly phase: "sending" | "unknown" };

/** Own one submitted intent; an ambiguous failure never proves rollback. */
export function createSubmissionRecovery<T extends object>() {
  const [state, setState] = createSignal<SubmissionState<T> | null>(null);
  const owns = (attempt: T, phase: SubmissionState<T>["phase"]) =>
    state()?.attempt === attempt && state()?.phase === phase;
  return {
    state,
    unknown: () => { const current = state(); return current?.phase === "unknown" ? current.attempt : null; },
    begin(attempt: T): boolean {
      if (state()) return false;
      setState({ attempt, phase: "sending" }); return true;
    },
    retry(attempt: T): boolean {
      if (!owns(attempt, "unknown")) return false;
      setState({ attempt, phase: "sending" }); return true;
    },
    acknowledge(attempt: T): boolean {
      if (!owns(attempt, "sending")) return false;
      setState(null); return true;
    },
    fail(attempt: T, error: unknown): void {
      if (!owns(attempt, "sending")) return;
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      setState(rejected ? null : { attempt, phase: "unknown" });
    },
    resolve(attempt: T): boolean {
      if (!owns(attempt, "unknown")) return false;
      setState(null); return true;
    },
  };
}
