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
}): JSX.Element {
  const sep = () => props.separator ?? "/";
  return (
    <nav aria-label="Breadcrumb" class={cn("flex flex-wrap items-center gap-1 text-sm", props.class)}>
      <For each={props.items}>
        {(crumb, index) => (
          <>
            <Show when={index() > 0}>
              <span class="text-subtle" aria-hidden="true">{sep()}</span>
            </Show>
            {crumb.href ? (
              <A href={crumb.href} class="text-accent hover:underline">
                {crumb.label}
              </A>
            ) : (
              <span class="font-semibold text-fg">{crumb.label}</span>
            )}
          </>
        )}
      </For>
    </nav>
  );
}
