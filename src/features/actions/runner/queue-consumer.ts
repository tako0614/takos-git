/**
 * Workflow queue consumer — forwards each run tick to its coordinator DO.
 *
 * The 5a dispatch seam enqueues a {@link RunTick} `{ runId, repoId }` onto
 * `WORKFLOW_QUEUE`. This consumer routes each message to
 * `ACTIONS_RUN.idFromName(runId)`; a delivery whose coordinator errors is retried
 * (the DLQ, wired in `main.tf`, absorbs poison messages). Ack/retry is per
 * message so one bad tick never blocks the batch.
 */

import type { RunTick } from "./contract.ts";
import type { DurableObjectNamespace } from "./cf-types.ts";

export interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface MessageBatch<T> {
  readonly messages: readonly QueueMessage<T>[];
}

export interface QueueEnv {
  ACTIONS_RUN?: DurableObjectNamespace;
}

/** Consume a batch of run ticks, forwarding each to its coordinator DO. */
export async function handleWorkflowQueue(
  batch: MessageBatch<RunTick>,
  env: QueueEnv,
): Promise<void> {
  const namespace = env.ACTIONS_RUN;
  for (const message of batch.messages) {
    if (!namespace) {
      message.retry();
      continue;
    }
    try {
      const tick = message.body;
      if (!tick || typeof tick.runId !== "string" || typeof tick.repoId !== "string") {
        // Malformed message — ack so it drains instead of poisoning the queue.
        message.ack();
        continue;
      }
      const stub = namespace.get(namespace.idFromName(tick.runId));
      const response = await stub.fetch(
        new Request("https://actions-run.internal/tick", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(tick),
        }),
      );
      if (response.ok) message.ack();
      else message.retry();
    } catch {
      message.retry();
    }
  }
}
