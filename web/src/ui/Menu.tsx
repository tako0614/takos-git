import {
  createSignal,
  createUniqueId,
  For,
  Show,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { cn } from "../lib/cn.ts";
import { createReactiveListener } from "../lib/lifecycle.ts";
import { toSafeHref } from "../lib/safeHref.ts";

function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

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
 * `trigger` (rendered inside a button). Closes on outside-click, Escape (with
 * focus return), and focus-out, and supports Arrow/Home/End menuitem navigation.
 */
export function Menu(props: {
  trigger: JSX.Element;
  items: readonly MenuItem[];
  align?: "left" | "right";
  triggerLabel?: string;
  class?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const menuId = createUniqueId();
  let root: HTMLDivElement | undefined;
  let triggerBtn: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  const menuItems = (): HTMLElement[] =>
    menuEl
      ? Array.from(menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
      : [];

  const onDocClick = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      setOpen(false);
      triggerBtn?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    e.preventDefault();
    const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    let next = 0;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  };
  createReactiveListener({
    active: open,
    target: document,
    type: "click",
    handler: onDocClick as EventListener,
  });
  createReactiveListener({
    active: open,
    target: document,
    type: "keydown",
    handler: onKey as EventListener,
  });

  return (
    <div
      ref={root}
      class={cn("relative inline-block", props.class)}
      onFocusOut={(e) => {
        if (!open() || !root) return;
        const next = e.relatedTarget as Node | null;
        if (next && !root.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerBtn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={open() ? menuId : undefined}
        aria-label={props.triggerLabel}
        class="tg-focus inline-flex items-center rounded-md"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div
          ref={menuEl}
          id={menuId}
          role="menu"
          class={cn(
            "absolute z-40 mt-1 min-w-[180px] overflow-hidden rounded-md border border-border bg-canvas py-1 shadow-lg",
            props.align === "left" ? "left-0" : "right-0",
          )}
        >
          <For each={props.items}>
            {(item) => {
              const linkClass = () =>
                cn(
                  "tg-focus block px-3 py-1.5 text-sm hover:bg-canvas-subtle",
                  item.danger ? "text-danger" : "text-fg",
                );
              const safeExternal = () => (item.href ? toSafeHref(item.href) : null);
              return (
                <>
                  <Show when={item.separated}>
                    <div class="my-1 border-t border-border" />
                  </Show>
                  {item.href ? (
                    isInternalHref(item.href) ? (
                      <A
                        href={item.href}
                        role="menuitem"
                        class={linkClass()}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                      </A>
                    ) : safeExternal() ? (
                      <a
                        href={safeExternal() as string}
                        rel="noopener noreferrer"
                        role="menuitem"
                        class={linkClass()}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                      </a>
                    ) : (
                      <span
                        role="menuitem"
                        aria-disabled="true"
                        class="block px-3 py-1.5 text-sm text-muted opacity-50"
                      >
                        {item.label}
                      </span>
                    )
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      class={cn(
                        "tg-focus block w-full px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle disabled:opacity-50",
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
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
