export interface RefSelectorKeyAction {
  readonly type: "move" | "pick" | "none";
  readonly index?: number;
}

/**
 * Computes the next active index or pick action for `RefSelector` keyboard
 * navigation (ArrowDown / ArrowUp / Home / End / Enter).
 *
 * Respects IME composition (`isComposing` / `keyCode === 229`) and leaves
 * `Home`/`End` untouched when the filter `<input>` is focused so text-caret
 * editing continues to work normally.
 */
export function resolveRefSelectorKey(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">,
  count: number,
  currentIndex: number,
  inFilterInput: boolean,
): RefSelectorKeyAction {
  if (event.isComposing || event.keyCode === 229) return { type: "none" };
  if (count <= 0) return { type: "none" };

  if (event.key === "ArrowDown") {
    const next = currentIndex < 0 ? 0 : (currentIndex + 1) % count;
    return { type: "move", index: next };
  }
  if (event.key === "ArrowUp") {
    const next = currentIndex <= 0 ? count - 1 : currentIndex - 1;
    return { type: "move", index: next };
  }
  if (event.key === "Home" && !inFilterInput) {
    return { type: "move", index: 0 };
  }
  if (event.key === "End" && !inFilterInput) {
    return { type: "move", index: count - 1 };
  }
  if (event.key === "Enter" && currentIndex >= 0 && currentIndex < count) {
    return { type: "pick", index: currentIndex };
  }
  return { type: "none" };
}
