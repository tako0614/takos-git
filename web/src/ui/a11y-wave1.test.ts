import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

describe("takos-git Wave 1 UI/UX & accessibility invariants", () => {
  test("Dialog implements focus trap, focus restoration, body scroll lock, and aria-labelledby", () => {
    const dialog = read("ui/Dialog.tsx");
    expect(dialog).toContain('aria-labelledby={props.title ? titleId : undefined}');
    expect(dialog).toContain('id={titleId}');
    expect(dialog).toContain('document.body.style.overflow = "hidden"');
    expect(dialog).toContain('if (previousFocus?.isConnected) previousFocus.focus();');
    expect(dialog).toContain('if (event.key !== "Tab" || !panel) return;');
  });

  test("Menu wires aria-controls, Escape focus return, Arrow navigation, focusout, and SPA <A>", () => {
    const menu = read("ui/Menu.tsx");
    expect(menu).toContain("aria-controls={menuId}");
    expect(menu).toContain("triggerBtn?.focus()");
    expect(menu).toContain('["ArrowDown", "ArrowUp", "Home", "End"]');
    expect(menu).toContain("onFocusOut={");
    expect(menu).toContain("<A\n");
  });

  test("Fields auto-assign fallback ids and wire hint/error via aria-describedby", () => {
    const fields = read("ui/Fields.tsx");
    expect(fields.match(/const resolvedId = \(\) => local\.id \?\? \(rest\.name \? undefined : fallbackId\);/gu))
      .toHaveLength(3);
    expect(fields).toContain('id={errorId} role="alert"');
    expect(fields).toContain("id={hintId}");
    expect(fields).toContain("const owned = new Set([hintId, errorId]);");
  });

  test("TopBar uses Sun/Moon theme icons, named global search, and AppShell has skip-to-content", () => {
    const topBar = read("app/TopBar.tsx");
    const appShell = read("app/AppShell.tsx");
    const repoLayout = read("app/RepoLayout.tsx");
    expect(topBar).toContain("<Icons.Sun");
    expect(topBar).toContain("<Icons.Moon");
    expect(topBar).toContain('setThemePref(isDark() ? "light" : "dark")');
    expect(topBar).toContain('name="globalJump"');
    expect(appShell).toContain('href="#main"');
    expect(appShell).toContain('id="main"');
    expect(appShell).toContain("applyDocumentTitle(location.pathname)");
    expect(repoLayout).not.toContain("Coming in Phase 4b");
    expect(repoLayout).toContain("alsoActivePrefixes:");
  });

  test("ToastHost announces notifications and DiffView exposes aria-expanded", () => {
    const toast = read("ui/ToastHost.tsx");
    const diff = read("ui/DiffView.tsx");
    const nav = read("ui/UnderlineNav.tsx");
    expect(toast).toContain('aria-live="polite"');
    expect(toast).toContain('role={item.type === "error" ? "alert" : "status"}');
    expect(diff).toContain("aria-expanded={open()}");
    expect(nav).toContain("moveTabFocus(e)");
  });
});
