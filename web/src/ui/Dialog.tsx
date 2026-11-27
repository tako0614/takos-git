import { createEffect, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";
import { createReactiveListener } from "../lib/lifecycle.ts";
import {
  handleDialogKeyDown,
  popDialog,
  pushDialog,
  resolveInitialFocus,
  restoreDialogFocus,
} from "./dialog-a11y.ts";
import { IconButton } from "./IconButton.tsx";

/**
 * A modal dialog rendered in a Portal with a backdrop, Escape-to-close, focus
 * trap + focus restoration, `aria-labelledby`, and reference-counted body
 * scroll lock.
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
  const dialogToken = Symbol("dialog");
  const width = () =>
    props.size === "lg" ? "max-w-2xl" : props.size === "sm" ? "max-w-sm" : "max-w-lg";

  let panel: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushDialog(dialogToken);

    const frame = requestAnimationFrame(() => {
      if (!panel) return;
      resolveInitialFocus(panel).focus();
    });

    onCleanup(() => {
      cancelAnimationFrame(frame);
      const wasTop = popDialog(dialogToken);
      if (wasTop) restoreDialogFocus(previousFocus);
    });
  });

  const onKey = (event: KeyboardEvent): void => {
    handleDialogKeyDown(dialogToken, event, panel, props.onClose);
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
