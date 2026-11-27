import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, createSignal } from "solid-js";
import {
  FOCUSABLE_SELECTOR,
  focusableElements,
  handleDialogKeyDown,
  isTopDialog,
  popDialog,
  pushDialog,
  resolveInitialFocus,
  restoreDialogFocus,
} from "./dialog-a11y.ts";
import { wireFieldAria } from "./fields-a11y.ts";
import { isUnderlineNavItemActive } from "./underline-nav-active.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

class MockElement {
  readonly attrs = new Map<string, string>();
  readonly children: MockElement[] = [];
  parent: MockElement | null = null;
  isConnected = true;
  visible = true;
  visibility = "visible";
  inert = false;
  hidden = false;
  disabled = false;
  tag: string;
  focused = false;

  constructor(
    tag: string,
    private readonly doc: MockDocument,
    attrs: Record<string, string> = {},
  ) {
    this.tag = tag.toLowerCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v);
      if (k === "disabled") this.disabled = true;
      if (k === "hidden") this.hidden = true;
      if (k === "inert") this.inert = true;
    }
  }

  append(...nodes: MockElement[]): void {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "hidden") this.hidden = true;
    if (name === "inert") this.inert = true;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "inert") this.inert = false;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  focus(): void {
    this.focused = true;
    this.doc.activeElement = this;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }

  getClientRects(): readonly object[] {
    return this.visible ? [{}] : [];
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (selector.includes("[inert]") && cur.inert) return cur;
      if (selector.includes("[hidden]") && cur.hidden) return cur;
      if (
        selector.includes("details:not([open]) > :not(summary)") &&
        cur.tag !== "summary" &&
        cur.parent?.tag === "details" &&
        !cur.parent.hasAttribute("open")
      ) {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  private matchesFocusable(): boolean {
    const tabIndex = this.attrs.get("tabindex");
    if (tabIndex === "-1") return false;
    if (this.disabled) return false;
    if (this.tag === "a") return this.attrs.has("href");
    if (["button", "input", "select", "textarea"].includes(this.tag)) {
      return this.attrs.get("type") !== "hidden";
    }
    if (this.tag === "summary") {
      return (
        this.parent?.tag === "details" &&
        this.parent.children.find((c) => c.tag === "summary") === this
      );
    }
    return tabIndex !== undefined;
  }

  private allDescendants(): MockElement[] {
    return this.children.flatMap((c) => [c, ...c.allDescendants()]);
  }

  querySelectorAll(_selector: string): MockElement[] {
    return this.allDescendants().filter((el) => el.matchesFocusable());
  }
}

class MockDocument {
  activeElement: MockElement | null = null;
  body = { style: { overflow: "auto" } };
  private readonly byId = new Map<string, MockElement>();

  register(id: string, el: MockElement): void {
    el.setAttribute("id", id);
    this.byId.set(id, el);
  }

  getElementById(id: string): MockElement | null {
    return this.byId.get(id) ?? null;
  }
}

const originalGetComputedStyle = globalThis.getComputedStyle;
afterEach(() => {
  globalThis.getComputedStyle = originalGetComputedStyle;
});

function makeKeyEvent(
  key: string,
  extra: Partial<{ shiftKey: boolean; isComposing: boolean; keyCode: number }> = {},
): { event: KeyboardEvent; isPrevented: () => boolean } {
  let prevented = false;
  const event = {
    key,
    shiftKey: extra.shiftKey ?? false,
    isComposing: extra.isComposing ?? false,
    keyCode: extra.keyCode ?? 0,
    preventDefault() {
      prevented = true;
    },
  } as unknown as KeyboardEvent;
  return { event, isPrevented: () => prevented };
}

describe("Dialog stack, scroll lock, IME Escape, and focus trap behavior", () => {
  test("stacked dialogs ref-count body scroll lock and only topmost handles Escape/Tab", () => {
    const doc = new MockDocument();
    const asDoc = doc as unknown as Document;
    globalThis.getComputedStyle = ((el: MockElement) => ({
      visibility: el.visibility,
    })) as unknown as typeof getComputedStyle;

    const panelA = new MockElement("div", doc, { tabindex: "-1" });
    const btnA = new MockElement("button", doc);
    panelA.append(btnA);

    const panelB = new MockElement("div", doc, { tabindex: "-1" });
    const firstB = new MockElement("button", doc);
    const lastB = new MockElement("button", doc);
    panelB.append(firstB, lastB);

    const tokenA = Symbol("dialog-a");
    const tokenB = Symbol("dialog-b");
    let closedA = 0;
    let closedB = 0;

    pushDialog(tokenA, asDoc);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(isTopDialog(tokenA)).toBe(true);

    pushDialog(tokenB, asDoc);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(isTopDialog(tokenA)).toBe(false);
    expect(isTopDialog(tokenB)).toBe(true);

    // Escape during IME composition is ignored by both dialogs.
    const imeEsc = makeKeyEvent("Escape", { isComposing: true });
    handleDialogKeyDown(tokenA, imeEsc.event, panelA as unknown as HTMLElement, () => { closedA += 1; }, asDoc);
    handleDialogKeyDown(tokenB, imeEsc.event, panelB as unknown as HTMLElement, () => { closedB += 1; }, asDoc);
    expect(closedA).toBe(0);
    expect(closedB).toBe(0);
    expect(imeEsc.isPrevented()).toBe(false);

    const ime229 = makeKeyEvent("Escape", { keyCode: 229 });
    handleDialogKeyDown(tokenB, ime229.event, panelB as unknown as HTMLElement, () => { closedB += 1; }, asDoc);
    expect(closedB).toBe(0);

    // Shift+Tab from panelB itself wraps to lastB (not escaping backward).
    panelB.focus();
    const shiftFromPanel = makeKeyEvent("Tab", { shiftKey: true });
    handleDialogKeyDown(tokenB, shiftFromPanel.event, panelB as unknown as HTMLElement, () => { closedB += 1; }, asDoc);
    expect(shiftFromPanel.isPrevented()).toBe(true);
    expect(doc.activeElement).toBe(lastB);

    // Tab from lastB wraps to firstB; dialog A ignores it.
    const tabFromLast = makeKeyEvent("Tab");
    handleDialogKeyDown(tokenA, tabFromLast.event, panelA as unknown as HTMLElement, () => { closedA += 1; }, asDoc);
    expect(tabFromLast.isPrevented()).toBe(false);
    handleDialogKeyDown(tokenB, tabFromLast.event, panelB as unknown as HTMLElement, () => { closedB += 1; }, asDoc);
    expect(tabFromLast.isPrevented()).toBe(true);
    expect(doc.activeElement).toBe(firstB);

    // Real Escape closes ONLY topmost dialog B.
    const realEsc = makeKeyEvent("Escape");
    handleDialogKeyDown(tokenA, realEsc.event, panelA as unknown as HTMLElement, () => { closedA += 1; }, asDoc);
    handleDialogKeyDown(tokenB, realEsc.event, panelB as unknown as HTMLElement, () => { closedB += 1; }, asDoc);
    expect(closedA).toBe(0);
    expect(closedB).toBe(1);

    // Popping B keeps overflow hidden because A is still open.
    expect(popDialog(tokenB, asDoc)).toBe(true);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(isTopDialog(tokenA)).toBe(true);

    // Popping A restores original body overflow ("auto").
    expect(popDialog(tokenA, asDoc)).toBe(true);
    expect(doc.body.style.overflow).toBe("auto");
  });

  test("focusableElements filters hidden/inert/visibility-hidden/closed-details, respects autofocus, and falls back to #main", () => {
    const doc = new MockDocument();
    const asDoc = doc as unknown as Document;
    globalThis.getComputedStyle = ((el: MockElement) => ({
      visibility: el.visibility,
    })) as unknown as typeof getComputedStyle;

    const panel = new MockElement("div", doc, { tabindex: "-1" });
    const closedDetails = new MockElement("details", doc);
    const summary = new MockElement("summary", doc);
    const insideClosedDetails = new MockElement("button", doc);
    closedDetails.append(summary, insideClosedDetails);

    const hiddenBtn = new MockElement("button", doc, { hidden: "" });
    const inertWrapper = new MockElement("div", doc, { inert: "" });
    const inertBtn = new MockElement("button", doc);
    inertWrapper.append(inertBtn);

    const invisBtn = new MockElement("button", doc);
    invisBtn.visibility = "hidden";
    const zeroRectBtn = new MockElement("button", doc);
    zeroRectBtn.visible = false;
    const disabledCustom = new MockElement("button", doc, { tabindex: "0", disabled: "" });
    const autoInput = new MockElement("input", doc, { autofocus: "" });

    panel.append(
      closedDetails,
      hiddenBtn,
      inertWrapper,
      invisBtn,
      zeroRectBtn,
      disabledCustom,
      autoInput,
    );

    const found = focusableElements(panel as unknown as HTMLElement);
    expect(found).toEqual([
      summary as unknown as HTMLElement,
      autoInput as unknown as HTMLElement,
    ]);
    expect(resolveInitialFocus(panel as unknown as HTMLElement)).toBe(
      autoInput as unknown as HTMLElement,
    );
    expect(FOCUSABLE_SELECTOR).toContain("details > summary:first-of-type");
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"]):not(:disabled)');

    // Focus restoration falls back to #main when previousFocus is disconnected.
    const main = new MockElement("main", doc, { tabindex: "-1" });
    doc.register("main", main);
    const detached = new MockElement("button", doc);
    detached.isConnected = false;
    restoreDialogFocus(detached as unknown as HTMLElement, asDoc);
    expect(doc.activeElement).toBe(main);

    const connected = new MockElement("button", doc);
    restoreDialogFocus(connected as unknown as HTMLElement, asDoc);
    expect(doc.activeElement).toBe(connected);
  });
});

describe("UnderlineNav active matching & CSS tokens", () => {
  test("Code tab matches exact repo root and alsoActivePrefixes but not Issues/Pulls", () => {
    const codeTab = {
      href: "/alice/demo",
      end: true,
      alsoActivePrefixes: [
        "/alice/demo/tree",
        "/alice/demo/blob",
        "/alice/demo/commits",
        "/alice/demo/commit",
        "/alice/demo/compare",
      ],
    };
    const issuesTab = { href: "/alice/demo/issues" };

    expect(isUnderlineNavItemActive("/alice/demo", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/blob/main/README.md", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/tree/main/src", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/commits/main", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/commit/abc123", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/compare/main...feat", codeTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/issues", codeTab)).toBe(false);
    expect(isUnderlineNavItemActive("/alice/demo/issues/42", issuesTab)).toBe(true);
    expect(isUnderlineNavItemActive("/alice/demo/pulls", codeTab)).toBe(false);
  });

  test("UnderlineNav uses native <a link> with explicit aria-current and styles.css exposes attention-emphasis + dark fg-subtle", () => {
    const nav = read("ui/UnderlineNav.tsx");
    const css = read("styles.css");
    expect(nav).not.toContain("<A");
    expect(nav).toContain("aria-current={active() ? \"page\" : undefined}");
    expect(nav).toContain("moveTabFocus(e)");
    expect(css).toContain("--color-attention-emphasis: var(--attention-emphasis);");
    expect(css).not.toContain("--fg-subtle: #6e7681;");
  });
});

describe("Fields aria ownership & fallback ids", () => {
  test("wireFieldAria preserves caller-owned attributes/tokens and cleans up owned ones", () => {
    const doc = new MockDocument();
    const input = new MockElement("input", doc, {
      "aria-required": "true",
      "aria-describedby": "caller-help",
    });

    const [required, setRequired] = createSignal(true);
    const [error, setError] = createSignal<string | undefined>(undefined);
    const [hint, setHint] = createSignal<string | undefined>("Helpful hint");

    const dispose = createRoot((disposeRoot) => {
      wireFieldAria({
        control: () => input as unknown as HTMLElement,
        required,
        error,
        hint,
        hintId: "field-hint-1",
        errorId: "field-err-1",
      });
      return disposeRoot;
    });

    // Caller's aria-required="true" is preserved; hint token appended to caller token.
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("caller-help field-hint-1");

    // Flipping required=false must NOT remove caller-owned aria-required.
    setRequired(false);
    expect(input.getAttribute("aria-required")).toBe("true");

    // Setting error swaps hintId -> errorId and sets aria-invalid="true".
    setError("Required field");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("caller-help field-err-1");

    // Clearing error removes owned aria-invalid and restores hintId.
    setError(undefined);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("caller-help field-hint-1");

    // Disposing Field removes owned describedby token while preserving caller-help.
    dispose();
    expect(input.getAttribute("aria-describedby")).toBe("caller-help");
  });

  test("Fields always falls back to fallbackId even when name is set and resolves labelFor via ||", () => {
    const fields = read("ui/Fields.tsx");
    expect(fields.match(/const resolvedId = \(\) => local\.id \?\? fallbackId;/gu)).toHaveLength(3);
    expect(fields).toContain("const labelFor = () => props.for || control()?.id || undefined;");
    expect(fields).toContain('id={errorId} role="alert"');
    expect(fields).toContain("id={hintId}");
  });
});

describe("ToastHost, Menu, CloneMenu, RefSelector, TopBar, AppShell, Icons invariants", () => {
  test("ToastHost has no nested live region and marks each toast aria-atomic", () => {
    const toast = read("ui/ToastHost.tsx");
    expect(toast).not.toContain('aria-live="polite"');
    expect(toast).toContain('role={item.type === "error" ? "alert" : "status"}');
    expect(toast).toContain('aria-atomic="true"');
  });

  test("Menu, CloneMenu, and RefSelector set aria-controls only when open and guard IME Escape", () => {
    const menu = read("ui/Menu.tsx");
    const clone = read("views/code/CloneMenu.tsx");
    const refSel = read("views/code/RefSelector.tsx");

    for (const src of [menu, clone, refSel]) {
      expect(src).toContain("aria-controls={open() ? menuId : undefined}");
      expect(src).toContain("e.isComposing || e.keyCode === 229");
    }
    expect(menu).toContain("isInternalHref(item.href)");
    expect(menu).toContain("toSafeHref(item.href)");
    expect(menu).toContain('rel="noopener noreferrer"');
  });

  test("TopBar GlobalSearch guards IME Enter/Escape, AppShell restores title on cleanup, Icons checks aria-labelledby", () => {
    const topBar = read("app/TopBar.tsx");
    const appShell = read("app/AppShell.tsx");
    const icons = read("lib/Icons.tsx");
    const diff = read("ui/DiffView.tsx");

    expect(topBar).toContain("if (e.isComposing || e.keyCode === 229)");
    expect(topBar).toContain('if (e.key === "Enter") e.preventDefault();');
    expect(appShell).toContain("onCleanup(() => {");
    expect(appShell).toContain("document.title = initialTitle;");
    expect(icons).toContain('rest["aria-labelledby"] === undefined');
    expect(diff).toContain("aria-expanded={open()}");
  });
});
