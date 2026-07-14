import { Show, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";

export type BannerTone = "info" | "success" | "warning" | "danger";

const TONES: Record<BannerTone, { box: string; icon: JSX.Element }> = {
  info: {
    box: "border-accent-emphasis/40 bg-accent-subtle text-fg",
    icon: <Icons.Info class="h-4 w-4 text-accent" />,
  },
  success: {
    box: "border-success-emphasis/40 bg-success-subtle text-fg",
    icon: <Icons.Check class="h-4 w-4 text-success" />,
  },
  warning: {
    box: "border-attention/40 bg-attention-subtle text-fg",
    icon: <Icons.AlertTriangle class="h-4 w-4 text-attention" />,
  },
  danger: {
    box: "border-danger-emphasis/40 bg-danger-subtle text-fg",
    icon: <Icons.AlertTriangle class="h-4 w-4 text-danger" />,
  },
};

/** An inline flash/banner (GitHub "flash"). Use for page-level notices. */
export function Banner(props: {
  tone?: BannerTone;
  title?: string;
  class?: string;
  children?: JSX.Element;
  action?: JSX.Element;
}): JSX.Element {
  const tone = () => TONES[props.tone ?? "info"];
  return (
    <div
      role="status"
      class={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3 text-sm",
        tone().box,
        props.class,
      )}
    >
      <span class="mt-0.5 shrink-0">{tone().icon}</span>
      <div class="min-w-0 flex-1">
        <Show when={props.title}>
          <div class="font-semibold">{props.title}</div>
        </Show>
        <Show when={props.children}>
          <div class={cn(props.title && "mt-0.5", "text-muted")}>{props.children}</div>
        </Show>
      </div>
      <Show when={props.action}>
        <div class="shrink-0">{props.action}</div>
      </Show>
    </div>
  );
}
