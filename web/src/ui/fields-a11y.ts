import { createEffect, onCleanup } from "solid-js";

export interface FieldAriaOptions {
  readonly control: () => HTMLElement | null;
  readonly required: () => boolean | undefined;
  readonly error: () => string | undefined;
  readonly hint: () => string | undefined;
  readonly hintId: string;
  readonly errorId: string;
}

/**
 * Wires `aria-required`, `aria-invalid`, and `aria-describedby` on the field's
 * control without clobbering caller-owned attributes or tokens, and removes
 * owned attributes/tokens on cleanup.
 */
export function wireFieldAria(options: FieldAriaOptions): void {
  createEffect(() => {
    const el = options.control();
    if (!el || !options.required()) return;
    const prev = el.getAttribute("aria-required");
    if (prev === "true") return;
    el.setAttribute("aria-required", "true");
    onCleanup(() => {
      if (prev === null) el.removeAttribute("aria-required");
      else el.setAttribute("aria-required", prev);
    });
  });

  createEffect(() => {
    const el = options.control();
    if (!el || !options.error()) return;
    const prev = el.getAttribute("aria-invalid");
    if (prev === "true") return;
    el.setAttribute("aria-invalid", "true");
    onCleanup(() => {
      if (prev === null) el.removeAttribute("aria-invalid");
      else el.setAttribute("aria-invalid", prev);
    });
  });

  createEffect(() => {
    const el = options.control();
    if (!el) return;
    const token = options.error() ? options.errorId : options.hint() ? options.hintId : null;
    if (!token) return;
    const existing = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (!existing.includes(token)) {
      el.setAttribute("aria-describedby", [...existing, token].join(" "));
    }
    onCleanup(() => {
      const next = (el.getAttribute("aria-describedby") ?? "")
        .split(/\s+/u)
        .filter((id) => id && id !== token);
      if (next.length > 0) el.setAttribute("aria-describedby", next.join(" "));
      else el.removeAttribute("aria-describedby");
    });
  });
}
