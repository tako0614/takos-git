/**
 * Local domain-event descriptors for the issues feature.
 *
 * Issue mutations emit a small, self-describing {@link DomainEvent}. This module
 * deliberately does NOT import the webhooks feature — it exposes a settable sink
 * so the integrator can bridge these events to webhook delivery (or an audit log,
 * or a queue) at worker startup via {@link setDomainEventSink}. Until a sink is
 * registered, emission is a no-op, so the issues feature is fully testable and
 * shippable in isolation.
 *
 * Delivery lifecycle: {@link emitDomainEvent} takes a {@link BackgroundScope} as
 * its first argument. It has no way to start unowned work, so the sink's promise
 * is always either handed to `waitUntil` or awaited before the Response — the
 * bug this signature replaced was a bare `void Promise.resolve(sink(event))`
 * from a worker that never accepted an `ExecutionContext`, which meant every
 * issue webhook was cancelled the moment the handler answered.
 */

import type { BackgroundScope } from "../../lifecycle.ts";

export type IssueEventType =
  | "issue.opened"
  | "issue.edited"
  | "issue.closed"
  | "issue.reopened"
  | "issue.commented"
  | "issue.comment_edited"
  | "issue.comment_deleted"
  | "issue.labeled"
  | "issue.unlabeled"
  | "issue.assigned"
  | "issue.milestoned";

/** A fired issue-domain event the integrator can route to webhooks/audit. */
export interface DomainEvent {
  readonly type: IssueEventType;
  readonly repoId: string;
  /** `:owner` URL segment. */
  readonly owner: string;
  /** `:repo` URL segment. */
  readonly repo: string;
  /** The shared issue+PR number this event concerns. */
  readonly issueNumber: number;
  /** OIDC/Interface subject of the actor. */
  readonly actorSubject: string;
  /** Internal principal id of the actor. */
  readonly actorId: string;
  /** Epoch milliseconds. */
  readonly at: number;
  /** Event-specific extra fields (label name, milestone number, new state, …). */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type DomainEventSink = (event: DomainEvent) => void | Promise<void>;

/** Log label a fired event is attributed to when its sink fails. */
function eventLabel(event: DomainEvent): string {
  return `issue-event ${event.type} ${event.owner}/${event.repo}#${event.issueNumber}`;
}

let currentSink: DomainEventSink | null = null;

/**
 * Register (or clear with `null`) the process-wide sink issue events are handed
 * to. The integrator wires this to the webhooks module without the issues feature
 * ever depending on it.
 */
export function setDomainEventSink(sink: DomainEventSink | null): void {
  currentSink = sink;
}

/**
 * Fire an event at the registered sink under `scope`, which owns the sink's
 * promise (see {@link BackgroundScope}). Never throws into the request path: a
 * misbehaving sink must not break the mutation that already committed, and the
 * scope is the single place that catches + logs the failure.
 */
export function emitDomainEvent(
  scope: BackgroundScope,
  event: DomainEvent,
): void {
  const sink = currentSink;
  if (!sink) return;
  scope.run(eventLabel(event), () => sink(event));
}

export interface BuildEventInput {
  readonly type: IssueEventType;
  readonly repoId: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly actorSubject: string;
  readonly actorId: string;
  readonly at: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Convenience constructor so handlers build a well-formed descriptor. */
export function buildEvent(input: BuildEventInput): DomainEvent {
  return { ...input };
}
