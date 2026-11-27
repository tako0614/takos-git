export interface RefSelectorKeyAction {
  readonly type: "move" | "pick" | "none";
  readonly index?: number;
}

export type RefSelectorFocusScope = "input" | "option" | "other";

export type RefSelectorKeyEvent = Pick<KeyboardEvent, "key" | "isComposing" | "keyCode"> &
  Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">>;

/**
 * Computes the next active index or pick action for `RefSelector` keyboard
 * navigation (ArrowDown / ArrowUp / Home / End / Enter).
 *
 * - Ignores IME composition (`isComposing` / `keyCode === 229`) and modified
 *   shortcuts (`ctrlKey` / `metaKey` / `altKey`).
 * - Only operates when focus is in the filter input (`"input"`) or on a ref
 *   option (`"option"`), so `"other"` controls (Clear button, Branches/Tags
 *   tabs, trigger button) keep their native `Enter`/`Home`/`End` behavior.
 * - Leaves `Home`/`End` untouched in `"input"` so text-caret editing works.
 */
export function resolveRefSelectorKey(
  event: RefSelectorKeyEvent,
  count: number,
  currentIndex: number,
  scope: RefSelectorFocusScope,
): RefSelectorKeyAction {
  if (event.isComposing || event.keyCode === 229) return { type: "none" };
  if (event.ctrlKey || event.metaKey || event.altKey) return { type: "none" };
  if (scope === "other" || count <= 0) return { type: "none" };

  if (event.key === "ArrowDown") {
    const next = currentIndex < 0 ? 0 : (currentIndex + 1) % count;
    return { type: "move", index: next };
  }
  if (event.key === "ArrowUp") {
    const next = currentIndex <= 0 ? count - 1 : currentIndex - 1;
    return { type: "move", index: next };
  }
  if (event.key === "Home" && scope === "option") {
    return { type: "move", index: 0 };
  }
  if (event.key === "End" && scope === "option") {
    return { type: "move", index: count - 1 };
  }
  if (event.key === "Enter" && currentIndex >= 0 && currentIndex < count) {
    return { type: "pick", index: currentIndex };
  }
  return { type: "none" };
}
