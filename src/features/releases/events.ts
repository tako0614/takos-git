/**
 * Event descriptors emitted by the releases feature.
 *
 * The releases service does not itself own a webhook/event sink — that runtime
 * wiring belongs to the webhooks feature + the integrator. This module only
 * BUILDS the typed descriptor at the state transition that should fan out, so the
 * integrator can route it (see the feature report's cross-feature wiring note).
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
