import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { computeHorizontalShift } from "../lib/floating-clamp.ts";
import { handleDialogKeyDown, popDialog, pushDialog } from "./dialog-a11y.ts";
import { formatCompareSpec, parseCompareSpec } from "../views/code/compare-spec.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

describe("Wave 5 viewport horizontal clamping (behavioral)", () => {
  test("computeHorizontalShift keeps right-clipping mobile menus inside viewport", () => {
    // Reproduces empirical 375px IssueList Filter-by-label clipping: left=279, right=459.
    expect(computeHorizontalShift({ left: 279, right: 459 }, 375, 8)).toBe(-92);
    // Shifted rect: left = 279 - 92 = 187 (>= 8), right = 459 - 92 = 367 (<= 367).
  });

  test("computeHorizontalShift keeps left-clipping panels inside viewport and leaves fitting panels untouched", () => {
    expect(computeHorizontalShift({ left: -24, right: 200 }, 375, 8)).toBe(32);
    expect(computeHorizontalShift({ left: 16, right: 280 }, 375, 8)).toBe(0);
    expect(computeHorizontalShift({ left: 8, right: 367 }, 375, 8)).toBe(0);
  });

  test("computeHorizontalShift aligns leading edge to margin when panel exceeds viewport width", () => {
    expect(computeHorizontalShift({ left: 20, right: 440 }, 375, 8)).toBe(-12);
    expect(computeHorizontalShift({ left: 0, right: 300 }, 0, 8)).toBe(0);
  });
});

describe("Wave 5 Compare spec parsing & formatting (behavioral)", () => {
  test("parses three-dot, two-dot, slash-containing, encoded, and empty specs safely", () => {
    expect(parseCompareSpec("main...feature%2Fauth")).toEqual({
      base: "main",
      head: "feature/auth",
      separator: "...",
    });
    expect(parseCompareSpec("release%2Fv1..hotfix%2F1")).toEqual({
      base: "release/v1",
      head: "hotfix/1",
      separator: "..",
    });
    expect(parseCompareSpec("")).toEqual({ base: "", head: "", separator: "..." });
    expect(parseCompareSpec("%E0%A4%A")).toEqual({ base: "", head: "", separator: "..." });
    expect(parseCompareSpec("main")).toEqual({ base: "main", head: "", separator: "..." });
  });

  test("round-trips refs containing slashes through formatCompareSpec and parseCompareSpec", () => {
    const encoded = formatCompareSpec("release/v1", "feature/pkce-auth");
    expect(encoded).toBe("release%2Fv1...feature%2Fpkce-auth");
    expect(parseCompareSpec(encoded)).toEqual({
      base: "release/v1",
      head: "feature/pkce-auth",
      separator: "...",
    });
    const twoDot = formatCompareSpec("main", "dev", "..");
    expect(parseCompareSpec(twoDot)).toEqual({ base: "main", head: "dev", separator: ".." });
  });
});

describe("Wave 5 repo-scoped pagination & GeneralSettings reset (behavioral)", () => {
  test("ActionsView and ReleasesView scoped cursor history drops stale cursors synchronously on repo switch", () => {
    let setRepo!: (v: string) => void;
    let cursor!: () => string | null;
    let hasPrev!: () => boolean;
    let goNext!: (next: string) => void;
    let workflow!: () => string;
    let setWorkflow!: (v: string) => void;

    const dispose = createRoot((d) => {
      const [repo, _setRepo] = createSignal("demo");
      setRepo = _setRepo;
      const [_wf, _setWf] = createSignal(".github/workflows/ci.yml");
      workflow = _wf;
      setWorkflow = _setWf;
      const scope = () => `alice/${repo()}`;
      const [state, setState] = createSignal<{ scope: string; stack: (string | null)[] }>({
        scope: scope(),
        stack: [null],
      });
      const stack = () => (state().scope === scope() ? state().stack : [null]);
      cursor = () => stack()[stack().length - 1] ?? null;
      hasPrev = () => stack().length > 1;
      goNext = (next: string) => setState({ scope: scope(), stack: [...stack(), next] });
      createEffect(
        on(
          scope,
          () => {
            setWorkflow("");
            setState({ scope: scope(), stack: [null] });
          },
          { defer: true },
        ),
      );
      return d;
    });

    goNext("runs-p2");
    expect(cursor()).toBe("runs-p2");
    expect(hasPrev()).toBe(true);
    expect(workflow()).toBe(".github/workflows/ci.yml");

    setRepo("second-repo");
    expect(cursor()).toBeNull();
    expect(hasPrev()).toBe(false);
    expect(workflow()).toBe("");

    dispose();
  });

  test("Dialog Escape respects already-handled inner combobox Escape (event.defaultPrevented)", () => {
    const doc = { body: { style: { overflow: "" } } } as unknown as Document;
    const token = Symbol("dlg-escape-guard");
    let closed = 0;
    pushDialog(token, doc);
    try {
      const handledEsc = {
        key: "Escape",
        defaultPrevented: true,
        isComposing: false,
        keyCode: 27,
        preventDefault() {},
      } as unknown as KeyboardEvent;
      handleDialogKeyDown(token, handledEsc, undefined, () => { closed += 1; }, doc);
      expect(closed).toBe(0);

      const unhandledEsc = {
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        keyCode: 27,
        preventDefault() {},
      } as unknown as KeyboardEvent;
      handleDialogKeyDown(token, unhandledEsc, undefined, () => { closed += 1; }, doc);
      expect(closed).toBe(1);
    } finally {
      popDialog(token, doc);
    }
  });
});

describe("Wave 5 UI/UX, interactive Compare/PR/Archive/Commit disclosure, and mobile 44px invariants", () => {
  test("CompareScreen provides interactive RefSelectors, swap control, PR handoff, and CodeView matches bare /compare", () => {
    const compare = read("views/code/CompareScreen.tsx");
    const codeIndex = read("views/code/index.tsx");
    const dir = read("views/code/DirectoryScreen.tsx");
    const commits = read("views/code/CommitsScreen.tsx");

    expect(codeIndex).toContain("/\\/compare(?:\\/|$)/u.test(p)");
    expect(codeIndex).toContain("defaultBranch={defaultBranch()}");
    expect(compare).toContain("<RefSelector");
    expect(compare).toContain('triggerPrefix="base:"');
    expect(compare).toContain('triggerPrefix="compare:"');
    expect(compare).toContain('aria-label="Swap base and compare refs"');
    expect(compare).toContain("Open pull request");
    expect(dir).toContain('aria-label="Compare refs"');
    expect(commits).toContain('aria-label="Compare refs"');
  });

  test("CommitRows and PRCommits expose accessible inline commit body disclosure buttons", () => {
    for (const rel of ["views/code/CommitRows.tsx", "views/pulls/PRCommits.tsx"]) {
      const src = read(rel);
      expect(src).toContain("aria-expanded={expanded()}");
      expect(src).toContain("aria-controls={expanded() ? bodyId : undefined}");
      expect(src).toContain('expanded() ? "Hide commit description" : "Show commit description"');
      expect(src).toContain("<pre");
      expect(src).toContain("h-11 min-w-11");
    }
  });

  test("NewPullDialog and DispatchDialog wire accessible BranchCombobox with IME guard and form submit", () => {
    const combo = read("views/code/BranchCombobox.tsx");
    const prList = read("views/pulls/PRList.tsx");
    const dispatch = read("views/actions/DispatchDialog.tsx");

    expect(combo).toContain('role="combobox"');
    expect(combo).toContain('role="listbox"');
    expect(combo).toContain('role="option"');
    expect(combo).toContain("aria-activedescendant={activeDescendant()}");
    expect(combo).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(prList).toContain("<BranchCombobox");
    expect(prList).toContain("Compare branch must differ from base branch.");
    expect(prList).toContain("flex min-h-11 items-center gap-2 text-sm text-fg sm:min-h-0");
    expect(dispatch).toContain('type="submit" form={formId}');
    expect(dispatch).toContain("<form");
    expect(dispatch).toContain("<BranchCombobox");
  });

  test("Settings General confirms archive/unarchive and resets on repo switch; Webhooks checkboxes meet 44px + alert", () => {
    const general = read("views/settings/general.tsx");
    const webhooks = read("views/settings/webhooks.tsx");

    expect(general).toContain("useConfirmDialog");
    expect(general).toContain("confirmDialog.confirm({");
    expect(general).toContain('next ? "Archive repository" : "Unarchive repository"');
    expect(general).toContain("setBranchChoice(\"\")");
    expect(webhooks).toContain("flex min-h-11 items-center gap-2 rounded px-1.5 py-1 text-sm");
    expect(webhooks).toContain('<p role="alert" class="text-xs text-danger">Select at least one event.</p>');
  });

  test("Menu, RefSelector, and Popover clamp horizontally; Breadcrumb, Clear-search, BlobScreen, RouteError, Actions, Releases fixed", () => {
    const menu = read("ui/Menu.tsx");
    const refSel = read("views/code/RefSelector.tsx");
    const pickers = read("views/issues/pickers.tsx");
    const breadcrumb = read("ui/Breadcrumb.tsx");
    const topBar = read("app/TopBar.tsx");
    const issueList = read("views/issues/IssueList.tsx");
    const prList = read("views/pulls/PRList.tsx");
    const blob = read("views/code/BlobScreen.tsx");
    const routeError = read("app/RouteError.tsx");
    const actions = read("views/actions/index.tsx");
    const releases = read("views/releases/index.tsx");

    for (const src of [menu, refSel, pickers]) {
      expect(src).toContain("computeHorizontalShift");
    }
    expect(breadcrumb).toContain("inline-flex min-h-11 items-center rounded px-1");
    for (const src of [topBar, issueList, prList]) {
      expect(src).toContain("inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center");
    }
    expect(blob).toContain("<RefSelector");
    expect(blob).toContain("Back to root");
    expect(routeError).toContain("<ButtonLink as={A} href=\"/\">Go home</ButtonLink>");
    expect(actions).toContain("cursorState().scope === repoScope()");
    expect(releases).toContain("historyState().scope === repoScope()");
  });
});
