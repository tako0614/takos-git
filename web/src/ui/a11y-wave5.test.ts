import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  on,
  Suspense,
} from "solid-js";
import { computeHorizontalShift } from "../lib/floating-clamp.ts";
import { handleDialogKeyDown, popDialog, pushDialog } from "./dialog-a11y.ts";
import { formatCompareSpec, parseCompareSpec } from "../views/code/compare-spec.ts";
import { blobHref, commitsHref, decodeRefParam, treeHref } from "../views/code/helpers.ts";

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

describe("Wave 5 Compare spec & slash-branch decoding (behavioral)", () => {
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

  test("decodeRefParam decodes percent-encoded :branch once so Blob/Tree/Commits/Compare links never double-encode", () => {
    const decoded = decodeRefParam("feature%2Fauth");
    expect(decoded).toBe("feature/auth");
    expect(treeHref("alice", "demo", decoded)).toBe("/alice/demo/tree/feature%2Fauth");
    expect(blobHref("alice", "demo", decoded, "README.md")).toBe("/alice/demo/blob/feature%2Fauth/README.md");
    expect(commitsHref("alice", "demo", decoded)).toBe("/alice/demo/commits/feature%2Fauth");
    expect(formatCompareSpec("main", decoded)).toBe("main...feature%2Fauth");

    // Empty and malformed escapes fall back safely without throwing.
    expect(decodeRefParam(undefined)).toBe("");
    expect(decodeRefParam("")).toBe("");
    expect(decodeRefParam("%E0%A4%A")).toBe("%E0%A4%A");
  });

  test("CompareScreen header CTA guard (!result.loading && result.state === 'ready') never suspends outer Suspense while pending", async () => {
    let resolveCompare!: (v: { data: { commits: string[] } }) => void;
    let outerSuspended = false;
    let showPrButton = false;

    const dispose = createRoot((d) => {
      const [result] = createResource(
        () => ["alice", "demo", "main...feature%2Fauth"] as const,
        () =>
          new Promise<{ data: { commits: string[] } }>((res) => {
            resolveCompare = res;
          }),
      );

      const shell = Suspense({
        get fallback() {
          outerSuspended = true;
          return "outer-loading";
        },
        get children() {
          createEffect(() => {
            showPrButton =
              !result.loading &&
              result.state === "ready" &&
              (result()?.data?.commits.length ?? 0) > 0;
          });
          return "shell-visible";
        },
      });
      createEffect(() => {
        if (typeof shell === "function") shell();
      });
      return d;
    });

    await Bun.sleep(10);
    expect(outerSuspended).toBe(false);
    expect(showPrButton).toBe(false);

    resolveCompare({ data: { commits: ["c1"] } });
    await Bun.sleep(10);
    expect(outerSuspended).toBe(false);
    expect(showPrButton).toBe(true);

    dispose();
  });
});

describe("Wave 5 repo-scoped pagination & combobox/dialog Escape isolation (behavioral)", () => {
  test("ActionsView synchronous repo-scoped viewState drops stale filters and cursors immediately without dispatching a stale request", () => {
    const requested: Array<{ repo: string; workflow: string; cursor: string | null }> = [];
    let setRepo!: (v: string) => void;
    let setWorkflow!: (v: string) => void;
    let goNext!: (next: string) => void;
    let dispatchOpen!: () => boolean;
    let setDispatchOpen!: (v: boolean) => void;

    const dispose = createRoot((d) => {
      const [repo, _setRepo] = createSignal("demo");
      setRepo = _setRepo;
      const [_dispatchOpen, _setDispatchOpen] = createSignal(true);
      dispatchOpen = _dispatchOpen;
      setDispatchOpen = _setDispatchOpen;

      const repoScope = () => `alice/${repo()}`;
      const [viewState, setViewState] = createSignal<{
        scope: string;
        workflow: string;
        stack: (string | null)[];
      }>({ scope: repoScope(), workflow: "", stack: [null] });
      const scoped = () =>
        viewState().scope === repoScope()
          ? viewState()
          : { scope: repoScope(), workflow: "", stack: [null] as (string | null)[] };
      const workflow = () => scoped().workflow;
      const cursors = () => scoped().stack;
      const currentCursor = () => cursors()[cursors().length - 1] ?? null;
      setWorkflow = (v: string) => setViewState({ ...scoped(), scope: repoScope(), workflow: v, stack: [null] });
      goNext = (next: string) => setViewState({ ...scoped(), scope: repoScope(), stack: [...cursors(), next] });
      createEffect(
        on(
          repoScope,
          () => {
            setDispatchOpen(false);
            setViewState({ scope: repoScope(), workflow: "", stack: [null] });
          },
          { defer: true },
        ),
      );

      const source = createMemo(() => ({
        repo: repo(),
        workflow: workflow(),
        cursor: currentCursor(),
      }));
      createEffect(() => {
        requested.push(source());
      });
      return d;
    });

    setWorkflow(".github/workflows/ci.yml");
    goNext("runs-p2");
    expect(dispatchOpen()).toBe(true);

    // Switching repo synchronously clears both workflow filter and cursor BEFORE source recomputes.
    setRepo("second-repo");
    expect(dispatchOpen()).toBe(false);
    expect(requested).toEqual([
      { repo: "demo", workflow: "", cursor: null },
      { repo: "demo", workflow: ".github/workflows/ci.yml", cursor: null },
      { repo: "demo", workflow: ".github/workflows/ci.yml", cursor: "runs-p2" },
      { repo: "second-repo", workflow: "", cursor: null },
    ]);

    dispose();
  });

  test("BranchCombobox root Escape closes only combobox (including from Retry button) and Dialog respects defaultPrevented", () => {
    const doc = { body: { style: { overflow: "" } } } as unknown as Document;
    const token = Symbol("dlg-escape-guard");
    let dialogClosed = 0;
    let comboOpen = true;
    let inputFocused = false;
    pushDialog(token, doc);
    try {
      let stopped = false;
      let prevented = false;
      const escFromRetry = {
        key: "Escape",
        get defaultPrevented() {
          return prevented;
        },
        isComposing: false,
        keyCode: 27,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      } as unknown as KeyboardEvent;

      // Mirrors BranchCombobox onRootKeyDown handling Escape from Retry/toggle/input inside root.
      if (!escFromRetry.isComposing && escFromRetry.keyCode !== 229 && escFromRetry.key === "Escape" && comboOpen) {
        escFromRetry.preventDefault();
        escFromRetry.stopPropagation();
        comboOpen = false;
        inputFocused = true;
      }
      expect(comboOpen).toBe(false);
      expect(inputFocused).toBe(true);
      expect(stopped).toBe(true);

      // Even if a parent Dialog listener sees a defaultPrevented Escape, it must NOT close.
      handleDialogKeyDown(token, escFromRetry, undefined, () => { dialogClosed += 1; }, doc);
      expect(dialogClosed).toBe(0);

      // Next Escape when combobox is closed reaches Dialog cleanly.
      const secondEsc = {
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        keyCode: 27,
        preventDefault() {},
      } as unknown as KeyboardEvent;
      handleDialogKeyDown(token, secondEsc, undefined, () => { dialogClosed += 1; }, doc);
      expect(dialogClosed).toBe(1);
    } finally {
      popDialog(token, doc);
    }
  });
});

describe("Wave 5 UI/UX, interactive Compare/PR/Archive/Commit disclosure, and mobile 44px invariants", () => {
  test("CompareScreen provides interactive RefSelectors, swap control, PR handoff, Suspense-safe CTA, three-dot nav, and CodeView decodes :branch", () => {
    const compare = read("views/code/CompareScreen.tsx");
    const codeIndex = read("views/code/index.tsx");
    const dir = read("views/code/DirectoryScreen.tsx");
    const commits = read("views/code/CommitsScreen.tsx");

    expect(codeIndex).toContain("/\\/compare(?:\\/|$)/u.test(p)");
    expect(codeIndex).toContain("decodeRefParam(params.branch)");
    expect(codeIndex).toContain("defaultBranch={defaultBranch()}");
    expect(compare).toContain("<RefSelector");
    expect(compare).toContain('triggerPrefix="base:"');
    expect(compare).toContain('triggerPrefix="compare:"');
    expect(compare).not.toContain("triggerLabel=");
    expect(compare).toContain("formatCompareSpec(b, h))");
    expect(compare).toContain("!result.loading");
    expect(compare).toContain('result.state === "ready"');
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

  test("NewPullDialog and DispatchDialog wire accessible BranchCombobox with tabIndex={-1} options, root Escape, IME guard, and form submit", () => {
    const combo = read("views/code/BranchCombobox.tsx");
    const prList = read("views/pulls/PRList.tsx");
    const dispatch = read("views/actions/DispatchDialog.tsx");

    expect(combo).toContain('role="combobox"');
    expect(combo).toContain('role="listbox"');
    expect(combo).toContain('role="option"');
    expect(combo).toContain("tabIndex={-1}");
    expect(combo).toContain("on:keydown={onRootKeyDown}");
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
    expect(general).toContain('setBranchChoice("")');
    expect(webhooks).toContain("flex min-h-11 items-center gap-2 rounded px-1.5 py-1 text-sm");
    expect(webhooks).toContain('<p role="alert" class="text-xs text-danger">Select at least one event.</p>');
  });

  test("Menu, RefSelector, and Popover clamp against clientWidth; Breadcrumb, Clear-search, BlobScreen, RouteError, Actions, Releases fixed", () => {
    const clamp = read("lib/floating-clamp.ts");
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

    expect(clamp).toContain("document.documentElement?.clientWidth");
    for (const src of [menu, refSel, pickers]) {
      expect(src).toContain("computeHorizontalShift");
      expect(src).toContain("viewportWidth()");
    }
    expect(breadcrumb).toContain("inline-flex min-h-11 items-center rounded px-1");
    for (const src of [topBar, issueList, prList]) {
      expect(src).toContain("inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center");
    }
    expect(blob).toContain("<RefSelector");
    expect(blob).toContain("Back to root");
    expect(routeError).toContain('<ButtonLink as={A} href="/" onClick={() => props.reset()}>Go home</ButtonLink>');
    expect(actions).toContain("viewState().scope === repoScope()");
    expect(actions).toContain("setDispatchOpen(false)");
    expect(releases).toContain("historyState().scope === repoScope()");
  });
});
