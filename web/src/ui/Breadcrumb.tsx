import { For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { cn } from "../lib/cn.ts";

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * A path breadcrumb — used for `owner / repo` headers and the in-repo file path
 * (`src / worker / index.ts`). The last crumb is rendered as inert text.
 */
export function Breadcrumb(props: {
  items: readonly Crumb[];
  class?: string;
  separator?: string;
  "aria-label"?: string;
}): JSX.Element {
  const sep = () => props.separator ?? "/";
  return (
    <nav
      aria-label={props["aria-label"] ?? "Breadcrumb"}
      class={cn("flex flex-wrap items-center gap-1 text-sm", props.class)}
    >
      <For each={props.items}>
        {(crumb, index) => (
          <>
            <Show when={index() > 0}>
              <span class="text-subtle" aria-hidden="true">{sep()}</span>
            </Show>
            {crumb.href ? (
              <A
                href={crumb.href}
                class="tg-focus inline-flex min-h-11 items-center rounded px-1 min-w-11 justify-center text-accent hover:underline sm:min-h-0 sm:min-w-0 sm:justify-start sm:px-0"
              >
                {crumb.label}
              </A>
            ) : (
              <span
                class="font-semibold text-fg"
                aria-current={index() === props.items.length - 1 ? "page" : undefined}
              >
                {crumb.label}
              </span>
            )}
          </>
        )}
      </For>
    </nav>
  );
}
