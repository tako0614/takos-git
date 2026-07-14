import { splitProps, type JSX, type ValidComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { cn } from "../lib/cn.ts";

export type ButtonVariant = "default" | "primary" | "danger" | "invisible" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "tg-focus inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 select-none";

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-10 px-4 text-sm",
};

const VARIANTS: Record<ButtonVariant, string> = {
  default:
    "border-border bg-canvas-subtle text-fg hover:bg-canvas-inset active:bg-canvas-inset",
  primary:
    "border-success-emphasis bg-success-emphasis text-white hover:brightness-110 active:brightness-95",
  danger:
    "border-border bg-canvas-subtle text-danger hover:bg-danger-emphasis hover:text-white hover:border-danger-emphasis",
  outline:
    "border-border bg-transparent text-accent hover:bg-accent-subtle",
  invisible:
    "border-transparent bg-transparent text-accent hover:bg-canvas-subtle",
};

export interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "block",
    "class",
    "type",
    "children",
  ]);
  return (
    <button
      type={local.type ?? "button"}
      class={cn(
        BASE,
        SIZES[local.size ?? "md"],
        VARIANTS[local.variant ?? "default"],
        local.block && "w-full",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </button>
  );
}

/**
 * A polymorphic button-styled element — render as an `<a>` (or router `A`) by
 * passing `as`. Keeps link + button chrome identical (GitHub parity).
 */
export function ButtonLink<T extends ValidComponent = "a">(
  props: { as?: T; variant?: ButtonVariant; size?: ButtonSize; block?: boolean } & Record<string, unknown>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["as", "variant", "size", "block", "class", "children"]);
  return (
    <Dynamic
      component={local.as ?? "a"}
      class={cn(
        BASE,
        SIZES[local.size ?? "md"],
        VARIANTS[local.variant ?? "default"],
        local.block && "w-full",
        local.class as string,
      )}
      {...rest}
    >
      {local.children as JSX.Element}
    </Dynamic>
  );
}
