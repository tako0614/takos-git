import { For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { cn } from "../lib/cn.ts";

export interface UnderlineNavItem {
  readonly label: string;
  readonly href: string;
  /** Exact-match highlight (default is prefix match). */
  readonly end?: boolean;
  readonly icon?: JSX.Element;
  readonly counter?: number | null;
}

/**
 * GitHub's repo tab bar: a horizontal, scrollable row of `<A>` links with an
 * active underline driven by the router. `end` marks the exact-match (Code) tab.
 */
export function UnderlineNav(props: {
  items: readonly UnderlineNavItem[];
  class?: string;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <nav
      aria-label={props["aria-label"] ?? "Repository"}
      class={cn(
        "flex gap-1 overflow-x-auto border-b border-border px-2",
        props.class,
      )}
    >
      <For each={props.items}>
        {(item) => (
          <A
            href={item.href}
            end={item.end}
            class="tg-focus group -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-fg hover:border-border"
            activeClass="!border-attention-emphasis font-semibold"
            inactiveClass="text-muted hover:text-fg"
          >
            <Show when={item.icon}>
              <span class="text-muted group-hover:text-fg">{item.icon}</span>
            </Show>
            <span>{item.label}</span>
            <Show when={item.counter != null}>
              <span class="rounded-full bg-neutral-muted px-2 text-xs leading-5 text-fg">
                {item.counter}
              </span>
            </Show>
          </A>
        )}
      </For>
    </nav>
  );
}

/** A non-routed tab bar (in-page state), for settings sub-navigation etc. */
export function Tabs(props: {
  items: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  class?: string;
}): JSX.Element {
  return (
    <div role="tablist" class={cn("flex gap-1 border-b border-border", props.class)}>
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="tab"
            data-tab-id={item.id}
            aria-selected={props.active === item.id}
            onClick={() => props.onSelect(item.id)}
            class={cn(
              "tg-focus -mb-px border-b-2 px-3 py-2 text-sm",
              props.active === item.id
                ? "border-attention-emphasis font-semibold text-fg"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
