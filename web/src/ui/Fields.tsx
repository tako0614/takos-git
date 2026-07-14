import { splitProps, Show, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

const FIELD_BASE =
  "tg-focus w-full rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-subtle disabled:opacity-60";

/** A labeled field wrapper (label + optional hint/error). */
export function Field(props: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  for?: string;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={cn("flex flex-col gap-1.5", props.class)}>
      <Show when={props.label}>
        <label for={props.for} class="text-sm font-semibold text-fg">
          {props.label}
          <Show when={props.required}>
            <span class="ml-0.5 text-danger">*</span>
          </Show>
        </label>
      </Show>
      {props.children}
      <Show when={props.error}>
        <span class="text-xs text-danger">{props.error}</span>
      </Show>
      <Show when={props.hint && !props.error}>
        <span class="text-xs text-muted">{props.hint}</span>
      </Show>
    </div>
  );
}

export function TextInput(
  props: JSX.InputHTMLAttributes<HTMLInputElement>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "type"]);
  return <input type={local.type ?? "text"} class={cn(FIELD_BASE, local.class)} {...rest} />;
}

export function Textarea(
  props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <textarea class={cn(FIELD_BASE, "min-h-[96px] resize-y font-sans", local.class)} {...rest} />;
}

export function Select(
  props: JSX.SelectHTMLAttributes<HTMLSelectElement>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <select class={cn(FIELD_BASE, "pr-8", local.class)} {...rest}>
      {local.children}
    </select>
  );
}
