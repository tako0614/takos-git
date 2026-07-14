/**
 * Actions feature — public surface.
 *
 * The control plane (Phase 5a): workflow discovery, run planning/persistence,
 * status projection, HTTP routes, and the push-trigger hook. The runner execution
 * fabric (Phase 5b) is NOT here — it consumes the {@link dispatchWorkflowRun} seam
 * and the exported state-machine callbacks.
 */

// Route registration (wired into worker.ts).
export { registerActionsRoutes, actionsRoutes } from "./routes.ts";

// Push-trigger hook (wired into the receive-pack success path in worker.ts).
export {
  onPushDiscoverWorkflows,
  type AppliedRefUpdate,
} from "./push-trigger.ts";

// Dispatch seam + queue message shape (implemented by Phase 5b).
export {
  dispatchWorkflowRun,
  type DispatchResult,
  type WorkflowQueueMessage,
} from "./dispatch.ts";

// State-machine callbacks Phase 5b calls as jobs execute.
export {
  cancelRun,
  completeJob,
  finalizeRunIfComplete,
  startJob,
  startRun,
  updateStep,
  type StepPatch,
} from "./service.ts";

// Secret decryption for just-in-time runner injection (Phase 5b only).
export { decryptWorkflowSecret } from "./secrets.ts";

// Discovery + planning primitives (reused by tests + Phase 5b).
export {
  computeChangedFiles,
  discoverWorkflows,
  loadAndValidateWorkflow,
  listWorkflowFiles,
  WORKFLOWS_DIR,
  type WorkflowCandidate,
} from "./discovery.ts";
export { expandRunJobs, type ExpandedRunJob } from "./expansion.ts";
