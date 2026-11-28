export const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([type="hidden"]):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  'details > summary:first-of-type:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"]):not(:disabled)',
].join(",");

const openDialogs: symbol[] = [];
let initialBodyOverflow: string | null = null;

export function isFocusableVisible(el: HTMLElement): boolean {
  if (el.closest('[inert], [hidden], details:not([open]) > :not(summary)')) return false;
  if (typeof getComputedStyle === "function" && getComputedStyle(el).visibility === "hidden") {
    return false;
  }
  return el.getClientRects().length > 0;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusableVisible,
  );
}

export function resolveInitialFocus(panel: HTMLElement): HTMLElement {
  const items = focusableElements(panel);
  const autofocus = items.find((el) => el.hasAttribute("autofocus"));
  return autofocus ?? items[0] ?? panel;
}

export function pushDialog(token: symbol, doc: Document = document): void {
  if (openDialogs.includes(token)) return;
  if (openDialogs.length === 0) {
    initialBodyOverflow = doc.body.style.overflow;
    doc.body.style.overflow = "hidden";
  }
  openDialogs.push(token);
}

export function popDialog(token: symbol, doc: Document = document): boolean {
  const idx = openDialogs.lastIndexOf(token);
  if (idx < 0) return false;
  const wasTop = idx === openDialogs.length - 1;
  openDialogs.splice(idx, 1);
  if (openDialogs.length === 0 && initialBodyOverflow !== null) {
    doc.body.style.overflow = initialBodyOverflow;
    initialBodyOverflow = null;
  }
  return wasTop;
}

export function isTopDialog(token: symbol): boolean {
  return openDialogs.length > 0 && openDialogs[openDialogs.length - 1] === token;
}

export function restoreDialogFocus(
  previousFocus: HTMLElement | null,
  doc: Document = document,
): void {
  if (previousFocus?.isConnected) {
    previousFocus.focus();
    return;
  }
  const main = doc.getElementById("main");
  if (main && typeof main.focus === "function") main.focus();
}

export function handleDialogKeyDown(
  token: symbol,
  event: KeyboardEvent,
  panel: HTMLElement | undefined,
  onClose: () => void,
  doc: Document = document,
): void {
  if (!isTopDialog(token)) return;
  if (event.key === "Escape") {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== "Tab" || !panel) return;
  const items = focusableElements(panel);
  if (items.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = doc.activeElement;
  if (event.shiftKey) {
    if (active === first || active === panel || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !panel.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}
