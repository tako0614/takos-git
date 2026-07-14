/**
 * Event descriptors + settable sink for the forks feature.
 *
 * The fork + upstream-sync handlers do NOT import the webhooks feature. Instead
 * each fan-out transition builds a typed {@link ForkEvent} and hands it to a
 * process-wide sink via {@link emitForkEvent}. The integrator installs a sink
 * (`setForkEventSink`) that bridges these into webhook delivery (see
 * `src/features/event-bridge.ts`). Until a sink is installed, emission is a
 * no-op, so the forks feature stays testable + shippable in isolation.
 *
 * `repo` is the storage key (`<owner>/<name>`) of the repository whose webhooks
 * should fire — the SOURCE/upstream repo for a `fork.created` (GitHub fires the
 * `fork` event on the repo that was forked), the FORK repo for a `fork.synced`
 * (an upstream sync advances the fork's ref, i.e. a `push` on the fork).
 *
 * Emission is best-effort: a throwing/absent sink never fails the originating
 * request (the authoritative R2/D1 write has already committed).
 */

export type ForkEventType = "fork.created" | "fork.synced";

export interface ForkEvent {
  readonly type: ForkEventType;
  /** Storage key `<owner>/<name>` of the repo whose webhooks should fire. */
  readonly repo: string;
  /** Acting principal id (or "anon"). */
  readonly actorId: string;
  /** Non-secret JSON payload describing the transition. */
  readonly payload: Record<string, unknown>;
}

/**
 * Build the `fork.created` descriptor. `sourceRepo` is the upstream storage key
 * (the repo being forked) — its webhooks receive the `fork` event.
 */
export function buildForkCreatedEvent(
  sourceRepo: string,
  actorId: string,
  payload: Record<string, unknown>,
): ForkEvent {
  return { type: "fork.created", repo: sourceRepo, actorId, payload };
}

/**
 * Build the `fork.synced` descriptor. `forkRepo` is the fork's storage key — its
 * webhooks receive a `push` event because the sync advanced one of its refs.
 */
export function buildForkSyncedEvent(
  forkRepo: string,
  actorId: string,
  payload: Record<string, unknown>,
): ForkEvent {
  return { type: "fork.synced", repo: forkRepo, actorId, payload };
}

export type ForkEventSink = (event: ForkEvent) => void | Promise<void>;

let sink: ForkEventSink | null = null;

/** Install (or clear with `null`) the process-wide fork-event sink. */
export function setForkEventSink(next: ForkEventSink | null): void {
  sink = next;
}

/** Best-effort emit; a throwing/absent sink never disturbs the caller. */
export async function emitForkEvent(event: ForkEvent): Promise<void> {
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // The authoritative write already landed; event delivery is advisory.
  }
}
