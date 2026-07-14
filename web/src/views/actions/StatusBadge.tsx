import { type JSX } from "solid-js";
import { Label } from "../../ui/index.ts";
import {
  runStatusVisual,
  stepStatusVisual,
  toneText,
  type StatusVisual,
} from "./helpers.tsx";
import type { RunConclusion, RunStatus, StepStatus } from "../../api/types.ts";

function badge(v: StatusVisual, size: "sm" | "md"): JSX.Element {
  const iconCls = `${size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} ${v.spin ? "animate-spin" : ""}`;
  return (
    <Label tone={v.tone} title={v.label}>
      {v.icon(iconCls)}
      {v.label}
    </Label>
  );
}

/** A pill badge for a run/job's status + conclusion. */
export function RunStatusBadge(props: {
  status: RunStatus;
  conclusion: RunConclusion | null;
  size?: "sm" | "md";
}): JSX.Element {
  return badge(runStatusVisual(props.status, props.conclusion), props.size ?? "md");
}

/** A pill badge for a step's status + conclusion. */
export function StepStatusBadge(props: {
  status: StepStatus;
  conclusion: RunConclusion | null;
  size?: "sm" | "md";
}): JSX.Element {
  return badge(stepStatusVisual(props.status, props.conclusion), props.size ?? "sm");
}

function glyph(v: StatusVisual, cls?: string): JSX.Element {
  return (
    <span class={`${toneText(v.tone)} ${cls ?? ""}`} title={v.label} aria-label={v.label}>
      {v.icon(`h-4 w-4 ${v.spin ? "animate-spin" : ""}`)}
    </span>
  );
}

/** Just the coloured status glyph (no label) — used in dense list rows. */
export function RunStatusGlyph(props: {
  status: RunStatus;
  conclusion: RunConclusion | null;
  class?: string;
}): JSX.Element {
  return glyph(runStatusVisual(props.status, props.conclusion), props.class);
}

/** Coloured status glyph for a step. */
export function StepStatusGlyph(props: {
  status: StepStatus;
  conclusion: RunConclusion | null;
  class?: string;
}): JSX.Element {
  return glyph(stepStatusVisual(props.status, props.conclusion), props.class);
}
