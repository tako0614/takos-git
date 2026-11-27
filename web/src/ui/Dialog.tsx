import { createEffect, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";
import { createReactiveListener } from "../lib/lifecycle.ts";
import { IconButton } from "./IconButton.tsx";

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * A modal dialog rendered in a Portal with a backdrop, Escape-to-close, focus
 * trap + focus restoration, `aria-labelledby`, and body scroll lock.
 */
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title?: JSX.Element;
  children: JSX.Element;
  footer?: JSX.Element;
  size?: "sm" | "md" | "lg";
  class?: string;
}): JSX.Element {
  const titleId = createUniqueId();
  const width = () =>
    props.size === "lg" ? "max-w-2xl" : props.size === "sm" ? "max-w-sm" : "max-w-lg";

  let panel: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const frame = requestAnimationFrame(() => {
      if (!panel) return;
      const items = focusableElements(panel);
      (items[0] ?? panel).focus();
    });

    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    });
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || !panel) return;
    const items = focusableElements(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
  createReactiveListener({
    active: () => props.open,
    target: document,
    type: "keydown",
    handler: onKey as EventListener,
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
          style={{ background: "var(--overlay-backdrop)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.title ? titleId : undefined}
            tabIndex={-1}
            class={cn(
              "mt-8 w-full rounded-lg border border-border bg-canvas shadow-2xl outline-none",
              width(),
              props.class,
            )}
          >
            <Show when={props.title}>
              <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 id={titleId} class="text-sm font-semibold text-fg">{props.title}</h2>
                <IconButton aria-label="Close" onClick={() => props.onClose()}>
                  <Icons.X class="h-4 w-4" />
                </IconButton>
              </div>
            </Show>
            <div class="px-4 py-4">{props.children}</div>
            <Show when={props.footer}>
              <div class="flex justify-end gap-2 border-t border-border bg-canvas-subtle px-4 py-3">
                {props.footer}
              </div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
