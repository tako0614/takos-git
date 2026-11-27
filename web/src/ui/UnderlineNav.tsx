import { For, Show, type JSX } from "solid-js";
import { useHref, useLocation, useResolvedPath } from "@solidjs/router";
import { cn } from "../lib/cn.ts";
import { moveTabFocus } from "../lib/a11y.ts";
import { isUnderlineNavItemActive } from "./underline-nav-active.ts";

export interface UnderlineNavItem {
  readonly label: string;
  readonly href: string;
  /** Exact-match highlight (default is prefix match). */
  readonly end?: boolean;
  /** Extra path prefixes that also highlight this tab (e.g. blob/tree/commits for Code). */
  readonly alsoActivePrefixes?: readonly string[];
  readonly icon?: JSX.Element;
  readonly counter?: number | null;
}

/**
 * GitHub's repo tab bar: a horizontal, scrollable row of client-routed links
 * with an active underline and `aria-current="page"` driven by `location.pathname`
 * (including `alsoActivePrefixes` such as `/blob/*`, `/tree/*`, `/commits/*`).
 */
export function UnderlineNav(props: {
  items: readonly UnderlineNavItem[];
  class?: string;
  "aria-label"?: string;
}): JSX.Element {
  const location = useLocation();

  return (
    <nav
      aria-label={props["aria-label"] ?? "Repository"}
      class={cn(
        "flex gap-1 overflow-x-auto border-b border-border px-2",
        props.class,
      )}
    >
      <For each={props.items}>
        {(item) => {
          const resolved = useResolvedPath(() => item.href);
          const href = useHref(resolved);
          const active = () => isUnderlineNavItemActive(location.pathname, item);
          return (
            <a
              link
              href={href() || item.href}
              aria-current={active() ? "page" : undefined}
              class={cn(
                "tg-focus group -mb-px flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm hover:border-border sm:min-h-0 sm:py-2",
                active()
                  ? "!border-attention-emphasis font-semibold text-fg"
                  : "text-muted hover:text-fg",
              )}
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
            </a>
          );
        }}
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
            tabIndex={props.active === item.id ? 0 : -1}
            aria-selected={props.active === item.id}
            onClick={() => props.onSelect(item.id)}
            onKeyDown={(e) => {
              const next = moveTabFocus(e);
              if (next) props.onSelect(next);
            }}
            class={cn(
              "tg-focus -mb-px min-h-11 border-b-2 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2",
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
