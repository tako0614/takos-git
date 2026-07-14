/**
 * Event descriptors + settable sink for the releases feature.
 *
 * The releases handlers do NOT import the webhooks feature — they build a typed
 * {@link ReleaseEvent} at each fan-out state transition (publish / edit / delete)
 * and hand it to a process-wide sink via {@link emitReleaseEvent}. The integrator
 * installs a sink (`setReleaseEventSink`) that bridges these into webhook delivery
 * (see `src/features/event-bridge.ts`). Until a sink is installed, emission is a
 * no-op, so the releases feature stays testable + shippable in isolation.
 *
 * Emission is best-effort: a throwing/absent sink never fails the originating
 * request (the authoritative R2/D1 write has already committed).
 */

import type { ReleaseDto } from "./dto.ts";

export type ReleaseEventType =
  | "release.published"
  | "release.created"
  | "release.edited"
  | "release.deleted";

export interface ReleaseEvent {
  readonly event: ReleaseEventType;
  /** `<owner>/<name>`. */
  readonly repo: string;
  readonly action: "published" | "created" | "edited" | "deleted";
  readonly release: ReleaseDto;
  readonly at: number;
}

/**
 * Build the `release.published` descriptor. Emitted when a release first becomes
 * non-draft (create-published or draft→publish edit).
 */
export function buildReleasePublishedEvent(
  repo: string,
  release: ReleaseDto,
  at: number,
): ReleaseEvent {
  return { event: "release.published", repo, action: "published", release, at };
}

/** Build the `release.edited` descriptor (a non-publishing metadata edit). */
export function buildReleaseEditedEvent(
  repo: string,
  release: ReleaseDto,
  at: number,
): ReleaseEvent {
  return { event: "release.edited", repo, action: "edited", release, at };
}

/** Build the `release.deleted` descriptor (release row removed). */
export function buildReleaseDeletedEvent(
  repo: string,
  release: ReleaseDto,
  at: number,
): ReleaseEvent {
  return { event: "release.deleted", repo, action: "deleted", release, at };
}

export type ReleaseEventSink = (event: ReleaseEvent) => void | Promise<void>;

let sink: ReleaseEventSink | null = null;

/** Install (or clear with `null`) the process-wide release-event sink. */
export function setReleaseEventSink(next: ReleaseEventSink | null): void {
  sink = next;
}

/** Best-effort emit; a throwing/absent sink never disturbs the caller. */
export async function emitReleaseEvent(event: ReleaseEvent): Promise<void> {
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // The authoritative write already landed; event delivery is advisory.
  }
}
