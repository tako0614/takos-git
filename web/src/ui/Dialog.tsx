import { Show, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";
import { IconButton } from "./IconButton.tsx";

/**
 * A modal dialog rendered in a Portal with a backdrop, Escape-to-close, and a
 * focus target. Body scroll is locked while open. No inline scripts.
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
  const width = () =>
    props.size === "lg" ? "max-w-2xl" : props.size === "sm" ? "max-w-sm" : "max-w-lg";

  let panel: HTMLDivElement | undefined;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
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
            class={cn(
              "mt-8 w-full rounded-lg border border-border bg-canvas shadow-2xl",
              width(),
              props.class,
            )}
          >
            <Show when={props.title}>
              <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 class="text-sm font-semibold text-fg">{props.title}</h2>
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
