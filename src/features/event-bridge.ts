/**
 * Cross-feature runtime event bridge (integrator-owned).
 *
 * The issues, pulls, releases and forks features emit typed domain-event
 * descriptors through a settable, process-wide sink and never import the webhooks
 * feature themselves (so each stays testable + shippable in isolation). This
 * module is the ONE place that closes the loop: it installs those sinks so each
 * emitted event fans out through the webhooks feature's `dispatchWebhook` seam.
 *
 * The sink is (re)installed per request with a closure over the current `env` —
 * `env.DB` / `env.BUCKET` are the same stable bindings for every request in an
 * isolate, so installing on each request is cheap and never leaks request state.
 * Emission is best-effort (a throwing sink never disturbs the originating
 * mutation, which has already committed), matching each feature's contract.
 *
 * Event → webhook name mapping installed here:
 *  - issues  → `issues` / `issue_comment`
 *  - pulls   → `pull_request` / `pull_request_review` / `push`
 *  - releases → `release`
 *  - forks   → `fork` (on the upstream) / `push` (on the fork, upstream-sync)
 */

import { createDbClient, type DbClient } from "../db/index.ts";
import { setForkEventSink, type ForkEvent } from "./forks/events.ts";
import { setDomainEventSink, type DomainEvent } from "./issues/events.ts";
import { setRepoEventSink, type RepoEvent } from "./pulls/events.ts";
import { setReleaseEventSink } from "./releases/events.ts";
import { getRepoRow } from "./repos/repositories.ts";
import { webhookEncryptionKey } from "./webhooks/crypto.ts";
import { dispatchWebhook, type DispatchDeps } from "./webhooks/service.ts";

/** The env subset the bridge needs (superset-compatible with the worker Env). */
interface BridgeEnv {
  DB?: Parameters<typeof createDbClient>[0];
  BUCKET?: DispatchDeps["bucket"];
  WEBHOOK_SECRET_KEY?: string;
  APP_SESSION_SECRET?: string;
}

/**
 * Map an issues `DomainEvent.type` onto the top-level webhook event name a hook
 * subscribes to (GitHub-style `issues` / `issue_comment`).
 */
function issueWebhookEvent(type: DomainEvent["type"]): string {
  return type.startsWith("issue.comment") || type === "issue.commented"
    ? "issue_comment"
    : "issues";
}

/**
 * Map a pulls `RepoEvent.type` onto the top-level webhook event name
 * (`pull_request` / `pull_request_review` / `push`).
 */
function pullWebhookEvent(type: RepoEvent["type"]): string {
  if (type === "push") return "push";
  if (type === "pull_request.review.submitted") return "pull_request_review";
  return "pull_request";
}

/**
 * Map a forks `ForkEvent.type` onto the top-level webhook event name. A created
 * fork fires `fork` on the upstream; an upstream sync advances the fork's ref so
 * it fires `push` on the fork.
 */
function forkWebhookEvent(type: ForkEvent["type"]): string {
  return type === "fork.synced" ? "push" : "fork";
}

function dispatchDeps(env: BridgeEnv): DispatchDeps {
  return {
    encryptionKey: webhookEncryptionKey(env as never),
    bucket: env.BUCKET ?? null,
  };
}

/** Split an `<owner>/<name>` storage key into its two segments. */
function splitStorageKey(key: string): { owner: string; name: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}

/**
 * Install the issues + pulls domain-event sinks so each emitted event fans out
 * through active webhooks. Idempotent and cheap: safe to call on every request.
 * When the metadata plane is unconfigured (`env.DB` unset) the sinks are cleared,
 * so emission stays a no-op rather than throwing.
 */
export function installEventBridge(env: BridgeEnv): void {
  if (!env.DB) {
    setDomainEventSink(null);
    setRepoEventSink(null);
    setReleaseEventSink(null);
    setForkEventSink(null);
    return;
  }
  const db: DbClient = createDbClient(env.DB);
  const deps = dispatchDeps(env);

  setDomainEventSink((event) => {
    void dispatchWebhook(
      db,
      event.repoId,
      issueWebhookEvent(event.type),
      {
        action: event.type,
        owner: event.owner,
        repo: event.repo,
        number: event.issueNumber,
        actorSubject: event.actorSubject,
        ...(event.payload ?? {}),
      },
      deps,
    );
  });

  setRepoEventSink(async (event) => {
    const parts = splitStorageKey(event.repo);
    if (!parts) return;
    const row = await getRepoRow(db, parts.owner, parts.name);
    if (!row) return;
    await dispatchWebhook(
      db,
      row.id,
      pullWebhookEvent(event.type),
      { action: event.type, ...event.payload },
      deps,
    );
  });

  setReleaseEventSink(async (event) => {
    const parts = splitStorageKey(event.repo);
    if (!parts) return;
    const row = await getRepoRow(db, parts.owner, parts.name);
    if (!row) return;
    await dispatchWebhook(
      db,
      row.id,
      "release",
      { action: event.action, release: event.release },
      deps,
    );
  });

  setForkEventSink(async (event) => {
    const parts = splitStorageKey(event.repo);
    if (!parts) return;
    const row = await getRepoRow(db, parts.owner, parts.name);
    if (!row) return;
    await dispatchWebhook(
      db,
      row.id,
      forkWebhookEvent(event.type),
      { ...event.payload },
      deps,
    );
  });
}
