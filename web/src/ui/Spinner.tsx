import { type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

/** An accessible indeterminate spinner (pure CSS — no inline animation script). */
export function Spinner(props: { size?: number; class?: string; label?: string }): JSX.Element {
  const size = () => props.size ?? 16;
  return (
    <span
      role="status"
      aria-label={props.label ?? "Loading"}
      class={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-muted", props.class)}
      style={{ width: `${size()}px`, height: `${size()}px` }}
    />
  );
}

/** A centered spinner block for in-view loading states. */
export function LoadingBlock(props: { label?: string; class?: string }): JSX.Element {
  return (
    <div class={cn("flex items-center justify-center gap-2 py-10 text-sm text-muted", props.class)}>
      <Spinner />
      <span>{props.label ?? "Loading…"}</span>
    </div>
  );
}
