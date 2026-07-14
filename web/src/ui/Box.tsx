import { splitProps, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

/** A bordered surface — the GitHub "Box". Compose header/row/footer children. */
export function Box(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      class={cn(
        "rounded-md border border-border bg-canvas overflow-hidden",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

export function BoxHeader(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      class={cn(
        "flex items-center gap-2 border-b border-border bg-canvas-subtle px-4 py-3 text-sm font-semibold",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

export function BoxRow(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      class={cn(
        "border-b border-border px-4 py-3 last:border-b-0",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

export function BoxFooter(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      class={cn(
        "border-t border-border bg-canvas-subtle px-4 py-3 text-sm",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

/** A neutral rounded card, no header chrome. */
export function Card(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      class={cn("rounded-md border border-border bg-canvas p-4", local.class)}
      {...rest}
    >
      {local.children}
    </div>
  );
}
