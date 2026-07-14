import { splitProps, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

export interface IconButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required for a11y — icon-only buttons have no visible label. */
  "aria-label": string;
  size?: "sm" | "md";
}

/** A compact, square, icon-only button (toolbars, menu triggers, close). */
export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["size", "class", "type", "children"]);
  return (
    <button
      type={local.type ?? "button"}
      class={cn(
        "tg-focus inline-flex items-center justify-center rounded-md border border-transparent text-muted hover:bg-canvas-subtle hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        local.size === "sm" ? "h-6 w-6" : "h-8 w-8",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </button>
  );
}
