import { type JSX } from "solid-js";
import { Icons } from "../../ui/index.ts";
import type {
  RunConclusion,
  RunStatus,
  StepStatus,
  WorkflowJobDto,
  WorkflowRunDto,
} from "../../api/types.ts";

/** A run/job is terminal once the runner has stopped touching it. */
export function isTerminal(status: RunStatus): boolean {
  return status === "completed";
}

/** True while the run (or any of its jobs) may still change — drives polling. */
export function runIsLive(run: WorkflowRunDto): boolean {
  return !isTerminal(run.status);
}

export interface StatusVisual {
  readonly tone: "success" | "danger" | "attention" | "default" | "accent";
  readonly label: string;
  readonly icon: (cls: string) => JSX.Element;
  readonly spin: boolean;
}

/** Map a run/job (status + conclusion) to a badge tone, label, and icon. */
export function runStatusVisual(
  status: RunStatus,
  conclusion: RunConclusion | null,
): StatusVisual {
  if (status === "queued") {
    return { tone: "attention", label: "Queued", icon: (c) => <Icons.Clock class={c} />, spin: false };
  }
  if (status === "in_progress") {
    return { tone: "accent", label: "In progress", icon: (c) => <Icons.Loader class={c} />, spin: true };
  }
  // completed
  switch (conclusion) {
    case "success":
      return { tone: "success", label: "Success", icon: (c) => <Icons.Check class={c} />, spin: false };
    case "failure":
      return { tone: "danger", label: "Failure", icon: (c) => <Icons.AlertTriangle class={c} />, spin: false };
    case "timed_out":
      return { tone: "danger", label: "Timed out", icon: (c) => <Icons.Clock class={c} />, spin: false };
    case "cancelled":
      return { tone: "default", label: "Cancelled", icon: (c) => <Icons.Square class={c} />, spin: false };
    case "skipped":
      return { tone: "default", label: "Skipped", icon: (c) => <Icons.ChevronRight class={c} />, spin: false };
    default:
      return { tone: "default", label: "Completed", icon: (c) => <Icons.Check class={c} />, spin: false };
  }
}

/** Step status → the same visual vocabulary (steps have no queued state). */
export function stepStatusVisual(
  status: StepStatus,
  conclusion: RunConclusion | null,
): StatusVisual {
  if (status === "pending") {
    return { tone: "attention", label: "Pending", icon: (c) => <Icons.Clock class={c} />, spin: false };
  }
  if (status === "in_progress") {
    return { tone: "accent", label: "Running", icon: (c) => <Icons.Loader class={c} />, spin: true };
  }
  return runStatusVisual("completed", conclusion);
}

/** Colour class for the small status glyph (matches the badge tone). */
export function toneText(tone: StatusVisual["tone"]): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "danger":
      return "text-danger";
    case "attention":
      return "text-attention";
    case "accent":
      return "text-accent";
    default:
      return "text-muted";
  }
}

/** Elapsed time between two epoch-ms marks (or start→now while running). */
export function formatDuration(
  startedAt: number | null,
  completedAt: number | null,
): string | null {
  if (startedAt == null) return null;
  const end = completedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/** A short human ref (drop `refs/heads/`, `refs/tags/`). */
export function shortRef(ref: string | null): string {
  if (!ref) return "";
  return ref.replace(/^refs\/(heads|tags)\//u, "");
}

/** Job progress summary, e.g. "3 / 5 steps". */
export function stepProgress(job: WorkflowJobDto): string | null {
  const steps = job.steps;
  if (!steps || steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "completed").length;
  return `${done} / ${steps.length} steps`;
}
