/**
 * Public surface of the issues feature.
 *
 * The integrator imports `registerIssuesRoutes` into worker.ts and, to bridge
 * issue domain events to webhook delivery, calls `setDomainEventSink` at worker
 * startup (the issues feature never imports the webhooks module).
 */

export { registerIssuesRoutes, issueRoutes } from "./routes.ts";
export {
  setDomainEventSink,
  emitDomainEvent,
  buildEvent,
  type DomainEvent,
  type DomainEventSink,
  type IssueEventType,
} from "./events.ts";
export type {
  IssueDto,
  IssueCommentDto,
  LabelDto,
  MilestoneDto,
  PrincipalRef,
} from "./dto.ts";
