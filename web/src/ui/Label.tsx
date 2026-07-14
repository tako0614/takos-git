import { splitProps, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";
import type { Visibility } from "../api/contract.ts";

export type LabelTone =
  | "default"
  | "accent"
  | "success"
  | "danger"
  | "attention"
  | "done";

const TONES: Record<LabelTone, string> = {
  default: "border-border text-muted",
  accent: "border-accent-emphasis/40 text-accent bg-accent-subtle",
  success: "border-success-emphasis/40 text-success bg-success-subtle",
  danger: "border-danger-emphasis/40 text-danger bg-danger-subtle",
  attention: "border-attention/40 text-attention bg-attention-subtle",
  done: "border-done/40 text-done bg-done-subtle",
};

/** A small rounded label/badge (issue labels, counts, metadata pills). */
export function Label(props: {
  tone?: LabelTone;
  class?: string;
  children: JSX.Element;
  title?: string;
}): JSX.Element {
  const [local] = splitProps(props, ["tone", "class", "children", "title"]);
  return (
    <span
      title={local.title}
      class={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-4",
        TONES[local.tone ?? "default"],
        local.class,
      )}
    >
      {local.children}
    </span>
  );
}

/** A colored issue-label pill driven by a 6-hex color (no leading '#'). */
export function ColorLabel(props: { name: string; color: string }): JSX.Element {
  const hex = () => `#${props.color.replace(/^#/, "")}`;
  return (
    <span
      class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-4"
      style={{
        "border-color": `color-mix(in srgb, ${hex()} 55%, transparent)`,
        background: `color-mix(in srgb, ${hex()} 18%, transparent)`,
        color: hex(),
      }}
    >
      {props.name}
    </span>
  );
}

/** GitHub-style open/closed/merged/draft state pill (issues, PRs). */
export function StateLabel(props: {
  state: "open" | "closed" | "merged" | "draft";
  icon?: JSX.Element;
  class?: string;
}): JSX.Element {
  const tone = () =>
    props.state === "open"
      ? "bg-success-emphasis text-white"
      : props.state === "merged"
        ? "bg-done-emphasis text-white"
        : props.state === "draft"
          ? "bg-neutral-emphasis text-white"
          : "bg-danger-emphasis text-white";
  return (
    <span
      class={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold capitalize",
        tone(),
        props.class,
      )}
    >
      {props.icon}
      {props.state}
    </span>
  );
}

/** public/private/internal visibility badge shown beside a repo name. */
export function VisibilityBadge(props: { visibility: Visibility }): JSX.Element {
  return (
    <Label tone="default" class="uppercase tracking-wide">
      {props.visibility}
    </Label>
  );
}
