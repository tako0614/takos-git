import { Show, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

/** A centered "blankslate" for empty lists / not-yet-built views. */
export function EmptyState(props: {
  icon?: JSX.Element;
  title: string;
  description?: JSX.Element;
  action?: JSX.Element;
  class?: string;
}): JSX.Element {
  return (
    <div
      class={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 py-12 text-center",
        props.class,
      )}
    >
      <Show when={props.icon}>
        <div class="text-subtle">{props.icon}</div>
      </Show>
      <h3 class="text-base font-semibold text-fg">{props.title}</h3>
      <Show when={props.description}>
        <p class="max-w-md text-sm text-muted">{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="mt-1">{props.action}</div>
      </Show>
    </div>
  );
}
