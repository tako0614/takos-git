/**
 * Move focus among the `[role="tab"]` siblings of the currently-focused tab in
 * response to Arrow / Home / End keys (WAI-ARIA tabs pattern, automatic
 * activation). Wraps around at the ends.
 *
 * Returns the newly-focused tab's `data-tab-id` so the caller can activate it,
 * or `null` when the key isn't a tablist navigation key (caller ignores it).
 *
 * The focused element must be the tab button (`e.currentTarget`) and live
 * inside an element with `role="tablist"`; each tab should carry a
 * `data-tab-id` attribute.
 */
export function moveTabFocus(e: KeyboardEvent): string | null {
  const navKeys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!navKeys.includes(e.key)) return null;
  const current = e.currentTarget as HTMLElement | null;
  const list = current?.closest('[role="tablist"]');
  if (!current || !list) return null;
  const tabs = Array.from(
    list.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'),
  );
  const index = tabs.indexOf(current);
  if (index < 0) return null;
  let next = index;
  if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
  else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  else if (e.key === "Home") next = 0;
  else next = tabs.length - 1;
  e.preventDefault();
  tabs[next].focus();
  return tabs[next].dataset.tabId ?? null;
}

export interface FocusableLike {
  focus(): void;
  readonly isConnected?: boolean;
  readonly disabled?: boolean;
}

/**
 * Gate initial auto-focus for an editor or inline form element to once per edit
 * session so later remounts (e.g. toggling MarkdownEditor Preview -> Write
 * tabs) do not steal focus away from keyboard navigation.
 */
export function createOneShotFocus<T extends FocusableLike = HTMLElement>(): {
  arm: () => void;
  disarm: () => void;
  ref: (el: T) => void;
} {
  let pending = false;
  return {
    arm() {
      pending = true;
    },
    disarm() {
      pending = false;
    },
    ref(el: T) {
      if (!pending) return;
      pending = false;
      queueMicrotask(() => {
        if (el.isConnected !== false && !el.disabled) el.focus();
      });
    },
  };
}

/**
 * Focus `primary` only when it is connected and enabled; otherwise focus
 * `fallback` if connected (e.g. an enclosing `role="dialog"` panel) so focus
 * never drops onto `document.body`.
 */
export function focusConnected(
  primary: FocusableLike | null | undefined,
  fallback?: FocusableLike | null,
): boolean {
  if (primary && primary.isConnected !== false && !primary.disabled) {
    primary.focus();
    return true;
  }
  if (fallback && fallback.isConnected !== false && !fallback.disabled) {
    fallback.focus();
    return true;
  }
  return false;
}

/**
 * Handle Escape inside an inline edit form hosted within a modal Dialog.
 * Ignores IME composition, always consumes Escape so the outer Dialog stays
 * open, and cancels the inline edit only when no save request is in flight.
 */
export function handleInlineEditEscape(
  e: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode" | "preventDefault" | "stopPropagation">,
  busy: boolean,
  onCancel: () => void,
): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopPropagation();
  if (busy) return true;
  onCancel();
  return true;
}
