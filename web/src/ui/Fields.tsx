import {
  children as resolveChildren,
  createUniqueId,
  Show,
  splitProps,
  type JSX,
} from "solid-js";
import { cn } from "../lib/cn.ts";
import { wireFieldAria } from "./fields-a11y.ts";

const FIELD_BASE =
  "tg-focus w-full rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-subtle disabled:opacity-60";

/** A labeled field wrapper (label + optional hint/error) with AT wiring. */
export function Field(props: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  for?: string;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  const hintId = createUniqueId();
  const errorId = createUniqueId();
  const resolved = resolveChildren(() => props.children);
  const control = (): HTMLElement | null => {
    for (const node of resolved.toArray()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches("input, select, textarea")) return node;
      const nested = node.querySelector("input, select, textarea");
      if (nested) return nested as HTMLElement;
    }
    return null;
  };
  const labelFor = () => props.for || control()?.id || undefined;

  wireFieldAria({
    control,
    required: () => props.required,
    error: () => props.error,
    hint: () => props.hint,
    hintId,
    errorId,
  });

  return (
    <div class={cn("flex flex-col gap-1.5", props.class)}>
      <Show when={props.label}>
        <label for={labelFor()} class="text-sm font-semibold text-fg">
          {props.label}
          <Show when={props.required}>
            <span class="ml-0.5 text-danger" aria-hidden="true">*</span>
          </Show>
        </label>
      </Show>
      {resolved()}
      <Show when={props.error}>
        <span id={errorId} role="alert" class="text-xs text-danger">{props.error}</span>
      </Show>
      <Show when={props.hint && !props.error}>
        <span id={hintId} class="text-xs text-muted">{props.hint}</span>
      </Show>
    </div>
  );
}

export function TextInput(
  props: JSX.InputHTMLAttributes<HTMLInputElement>,
): JSX.Element {
  const fallbackId = createUniqueId();
  const [local, rest] = splitProps(props, ["class", "type", "id"]);
  const resolvedId = () => local.id ?? fallbackId;
  return (
    <input
      type={local.type ?? "text"}
      id={resolvedId()}
      class={cn(FIELD_BASE, "min-h-11 sm:min-h-0", local.class)}
      {...rest}
    />
  );
}

export function Textarea(
  props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
): JSX.Element {
  const fallbackId = createUniqueId();
  const [local, rest] = splitProps(props, ["class", "id"]);
  const resolvedId = () => local.id ?? fallbackId;
  return <textarea id={resolvedId()} class={cn(FIELD_BASE, "min-h-[96px] resize-y font-sans", local.class)} {...rest} />;
}

export function Select(
  props: JSX.SelectHTMLAttributes<HTMLSelectElement>,
): JSX.Element {
  const fallbackId = createUniqueId();
  const [local, rest] = splitProps(props, ["class", "children", "id"]);
  const resolvedId = () => local.id ?? fallbackId;
  return (
    <select id={resolvedId()} class={cn(FIELD_BASE, "min-h-11 pr-8 sm:min-h-0", local.class)} {...rest}>
      {local.children}
    </select>
  );
}
