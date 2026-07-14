/**
 * Local repo-event descriptors emitted by the pulls feature.
 *
 * The pulls handlers do NOT deliver webhooks or dispatch Actions themselves —
 * that cross-feature wiring is the integrator's job (webhooks + checks features
 * own delivery). Instead every state transition emits a typed descriptor through
 * a settable sink; the integrator installs a sink (`setRepoEventSink`) that fans
 * these into webhook delivery / check dispatch. Until a sink is installed, emit
 * is a no-op, so the pulls feature is testable and shippable in isolation.
 *
 * Emission is best-effort: a throwing sink never fails the originating request
 * (the authoritative R2/D1 write has already committed).
 */

export type RepoEventType =
  | "pull_request.opened"
  | "pull_request.edited"
  | "pull_request.closed"
  | "pull_request.reopened"
  | "pull_request.merged"
  | "pull_request.review.submitted"
  | "push";

export interface RepoEvent {
  readonly type: RepoEventType;
  /** R2 storage key `<owner>/<name>`. */
  readonly repo: string;
  /** Acting principal id (or "anon"). */
  readonly actorId: string;
  /** Non-secret JSON payload describing the transition. */
  readonly payload: Record<string, unknown>;
}

export type RepoEventSink = (event: RepoEvent) => void | Promise<void>;

let sink: RepoEventSink | null = null;

/** Install (or clear with `null`) the process-wide repo-event sink. */
export function setRepoEventSink(next: RepoEventSink | null): void {
  sink = next;
}

/** Best-effort emit; a throwing/absent sink never disturbs the caller. */
export async function emitRepoEvent(event: RepoEvent): Promise<void> {
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // The authoritative write already landed; event delivery is advisory.
  }
}
