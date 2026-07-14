import { For, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useToast, type ToastKind } from "../store/toast.ts";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";
import { IconButton } from "./IconButton.tsx";

const TONES: Record<ToastKind, { box: string; icon: JSX.Element }> = {
  success: { box: "border-success-emphasis/50", icon: <Icons.Check class="h-4 w-4 text-success" /> },
  error: { box: "border-danger-emphasis/50", icon: <Icons.AlertTriangle class="h-4 w-4 text-danger" /> },
  warning: { box: "border-attention/50", icon: <Icons.AlertTriangle class="h-4 w-4 text-attention" /> },
  info: { box: "border-accent-emphasis/50", icon: <Icons.Info class="h-4 w-4 text-accent" /> },
};

/** Renders the toast stack singleton. Mount once in AppShell. */
export function ToastHost(): JSX.Element {
  const toast = useToast();
  return (
    <Portal>
      <div class="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        <For each={toast.toasts}>
          {(item) => (
            <div
              class={cn(
                "pointer-events-auto flex items-start gap-2 rounded-md border bg-canvas px-3 py-2.5 text-sm shadow-lg",
                TONES[item.type].box,
              )}
              onMouseEnter={() => toast.pauseToast(item.id)}
              onMouseLeave={() => toast.resumeToast(item.id)}
            >
              <span class="mt-0.5 shrink-0">{TONES[item.type].icon}</span>
              <span class="min-w-0 flex-1 break-words text-fg">{item.message}</span>
              <IconButton
                aria-label="Dismiss"
                size="sm"
                onClick={() => toast.dismissToast(item.id)}
              >
                <Icons.X class="h-3.5 w-3.5" />
              </IconButton>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
