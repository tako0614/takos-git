import {
  children as resolveChildren,
  createEffect,
  createUniqueId,
  Show,
  splitProps,
  type JSX,
} from "solid-js";
import { cn } from "../lib/cn.ts";

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
  const labelFor = () => props.for ?? control()?.id ?? undefined;

  createEffect(() => {
    const el = control();
    if (!el) return;
    if (props.required) el.setAttribute("aria-required", "true");
    else el.removeAttribute("aria-required");
  });

  createEffect(() => {
    const el = control();
    if (!el) return;
    const owned = new Set([hintId, errorId]);
    const existing = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .filter((token) => token && !owned.has(token));
    if (props.error) existing.push(errorId);
    else if (props.hint) existing.push(hintId);
    if (existing.length > 0) el.setAttribute("aria-describedby", existing.join(" "));
    else el.removeAttribute("aria-describedby");
  });

  createEffect(() => {
    const el = control();
    if (!el) return;
    if (props.error) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
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
  const resolvedId = () => local.id ?? (rest.name ? undefined : fallbackId);
  return <input type={local.type ?? "text"} id={resolvedId()} class={cn(FIELD_BASE, local.class)} {...rest} />;
}

export function Textarea(
  props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
): JSX.Element {
  const fallbackId = createUniqueId();
  const [local, rest] = splitProps(props, ["class", "id"]);
  const resolvedId = () => local.id ?? (rest.name ? undefined : fallbackId);
  return <textarea id={resolvedId()} class={cn(FIELD_BASE, "min-h-[96px] resize-y font-sans", local.class)} {...rest} />;
}

export function Select(
  props: JSX.SelectHTMLAttributes<HTMLSelectElement>,
): JSX.Element {
  const fallbackId = createUniqueId();
  const [local, rest] = splitProps(props, ["class", "children", "id"]);
  const resolvedId = () => local.id ?? (rest.name ? undefined : fallbackId);
  return (
    <select id={resolvedId()} class={cn(FIELD_BASE, "pr-8", local.class)} {...rest}>
      {local.children}
    </select>
  );
}
