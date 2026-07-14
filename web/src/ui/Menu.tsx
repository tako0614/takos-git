import {
  createSignal,
  For,
  Show,
  onCleanup,
  type JSX,
} from "solid-js";
import { cn } from "../lib/cn.ts";

export interface MenuItem {
  readonly label: JSX.Element;
  readonly onSelect?: () => void;
  readonly href?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Render a divider above this item. */
  readonly separated?: boolean;
}

/**
 * A lightweight dropdown menu. The trigger is provided by the caller via
 * `trigger` (rendered inside a button). Closes on outside-click and Escape.
 * Anchored to the right by default (`align`).
 */
export function Menu(props: {
  trigger: JSX.Element;
  items: readonly MenuItem[];
  align?: "left" | "right";
  triggerLabel?: string;
  class?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  const bind = () => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  };
  onCleanup(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div ref={root} class={cn("relative inline-block", props.class)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={props.triggerLabel}
        class="tg-focus inline-flex items-center rounded-md"
        onClick={() => {
          const next = !open();
          setOpen(next);
          if (next) bind();
        }}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div
          role="menu"
          class={cn(
            "absolute z-40 mt-1 min-w-[180px] overflow-hidden rounded-md border border-border bg-canvas py-1 shadow-lg",
            props.align === "left" ? "left-0" : "right-0",
          )}
        >
          <For each={props.items}>
            {(item) => (
              <>
                <Show when={item.separated}>
                  <div class="my-1 border-t border-border" />
                </Show>
                {item.href ? (
                  <a
                    href={item.href}
                    role="menuitem"
                    class={cn(
                      "block px-3 py-1.5 text-sm hover:bg-canvas-subtle",
                      item.danger ? "text-danger" : "text-fg",
                    )}
                    onClick={() => setOpen(false)}
                  >
                    {item.label}
                  </a>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    class={cn(
                      "block w-full px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle disabled:opacity-50",
                      item.danger ? "text-danger" : "text-fg",
                    )}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect?.();
                    }}
                  >
                    {item.label}
                  </button>
                )}
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
