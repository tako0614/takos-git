import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEffect, createResource, createRoot, ErrorBoundary } from "solid-js";
import { resolveRefSelectorKey } from "../views/code/ref-selector-a11y.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

describe("RefSelector keyboard navigation (behavioral)", () => {
  test("ArrowDown and ArrowUp wrap around items and Enter picks active index", () => {
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 3, -1, "input"))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 3, 2, "input"))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "ArrowUp", isComposing: false, keyCode: 38 }, 3, -1, "input"))
      .toEqual({ type: "move", index: 2 });
    expect(resolveRefSelectorKey({ key: "ArrowUp", isComposing: false, keyCode: 38 }, 3, 0, "input"))
      .toEqual({ type: "move", index: 2 });
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: false, keyCode: 13 }, 3, 1, "input"))
      .toEqual({ type: "pick", index: 1 });
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: false, keyCode: 13 }, 3, -1, "input"))
      .toEqual({ type: "none" });
  });

  test("Home/End navigate on ref options without hijacking filter input caret", () => {
    expect(resolveRefSelectorKey({ key: "Home", isComposing: false, keyCode: 36 }, 4, 2, "input"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "End", isComposing: false, keyCode: 35 }, 4, 1, "input"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "Home", isComposing: false, keyCode: 36 }, 4, 2, "option"))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "End", isComposing: false, keyCode: 35 }, 4, 1, "option"))
      .toEqual({ type: "move", index: 3 });
  });

  test("does not hijack Enter/Home/End/Arrow keys from tabs, Clear button, or trigger (scope=other) or modified shortcuts", () => {
    for (const key of ["Enter", "Home", "End", "ArrowDown", "ArrowUp"]) {
      expect(resolveRefSelectorKey({ key, isComposing: false, keyCode: 13 }, 3, 0, "other"))
        .toEqual({ type: "none" });
    }
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: false, keyCode: 13, ctrlKey: true }, 3, 0, "input"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40, metaKey: true }, 3, 0, "option"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowUp", isComposing: false, keyCode: 38, altKey: true }, 3, 0, "option"))
      .toEqual({ type: "none" });
  });

  test("IME composition events and empty lists are ignored", () => {
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: true, keyCode: 13 }, 3, 0, "input"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 229 }, 3, 0, "input"))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 0, -1, "input"))
      .toEqual({ type: "none" });
  });
});

describe("ErrorBoundary + createResource retry ordering (behavioral)", () => {
  test("calling refetch() before reset() clears cached rejection and recovers", async () => {
    let shouldFail = true;
    let resetBoundary: (() => void) | undefined;
    let triggerRefetch: (() => unknown) | undefined;
    let observed = "";

    const dispose = createRoot((d) => {
      const [data, { refetch }] = createResource(async () => {
        await Promise.resolve();
        if (shouldFail) throw new Error("transient failure");
        return "recovered-payload";
      });
      triggerRefetch = refetch;

      const boundary = ErrorBoundary({
        fallback: (err, reset) => {
          resetBoundary = reset;
          return `error:${err instanceof Error ? err.message : String(err)}`;
        },
        get children() {
          const val = data();
          return val ? `ok:${val}` : "loading";
        },
      });

      createEffect(() => {
        const out = typeof boundary === "function" ? boundary() : boundary;
        observed = String(out);
      });
      return d;
    });

    await Bun.sleep(20);
    expect(observed).toBe("error:transient failure");
    expect(resetBoundary).toBeDefined();

    // Retry with refetch() BEFORE reset() — Solid clears cached error before boundary re-renders.
    shouldFail = false;
    void triggerRefetch!();
    resetBoundary!();
    await Bun.sleep(20);
    expect(observed).toBe("ok:recovered-payload");

    dispose();
  });

  test("all ErrorBoundary retry buttons call refetch before reset", () => {
    for (const rel of [
      "views/home/index.tsx",
      "views/issues/IssueList.tsx",
      "views/pulls/PRList.tsx",
      "views/pulls/PRFiles.tsx",
    ]) {
      const src = read(rel);
      expect(src).not.toMatch(/reset\(\);\s*void refetch/u);
      expect(src).toMatch(/void refetch\w*\(\);[\s\S]{0,40}reset\(\);/u);
    }
  });
});

describe("takos-git Wave 2 UI/UX & accessibility invariants", () => {
  test("TopBar provides mobile search toggle with conditional aria-controls and clear button outside label", () => {
    const topBar = read("app/TopBar.tsx");
    expect(topBar).toContain("aria-expanded={mobileSearchOpen()}");
    expect(topBar).toContain("aria-controls={mobileSearchOpen() ? mobileSearchId : undefined}");
    expect(topBar).toContain('aria-label="Clear search"');
    expect(topBar).not.toMatch(/<label[^>]*>[\s\S]*?<button/u);
  });

  test("RefSelector aligns combobox/listbox/option roles and guards Clear button click from closing popover", () => {
    const refSel = read("views/code/RefSelector.tsx");
    expect(refSel).toContain('role="combobox"');
    expect(refSel).toContain('role="listbox"');
    expect(refSel).toContain('role="option"');
    expect(refSel).toContain("aria-controls={open() ? listId : undefined}");
    expect(refSel).toContain("e.composedPath");
    expect(refSel).toContain("e.stopPropagation()");
  });

  test("RepoLayout distinguishes 404 vs non-404 errors, guards detail.error, and offers Retry", () => {
    const repoLayout = read("app/RepoLayout.tsx");
    const banner = read("ui/Banner.tsx");
    expect(repoLayout).toContain("const repoDetail = () => (detail.error ? undefined : detail.latest);");
    expect(repoLayout).toContain("const loadError = () => (detail.error && !notFound() ? detail.error : undefined);");
    expect(repoLayout).toContain('title="Could not load repository"');
    expect(repoLayout).toContain("onClick={() => void refetch()}");
    expect(banner).toContain('role={props.tone === "danger" ? "alert" : "status"}');
  });

  test("PRFiles and DiffView wire aria-expanded, conditional aria-controls, per-line labels, and IME-safe shortcuts", () => {
    const prFiles = read("views/pulls/PRFiles.tsx");
    const diffView = read("ui/DiffView.tsx");
    const reviewForm = read("views/pulls/ReviewForm.tsx");
    expect(prFiles).toContain("aria-expanded={open()}");
    expect(prFiles).toContain("aria-controls={open() ? bodyId : undefined}");
    expect(prFiles).toContain("Add review comment on ${props.file.path} line ${t().line}");
    expect(prFiles).toContain("focus-visible:opacity-100");
    expect(prFiles).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(prFiles).toContain('(e.ctrlKey || e.metaKey) && e.key === "Enter"');
    expect(diffView).toContain("aria-controls={open() ? bodyId : undefined}");
    expect(reviewForm).toContain("if (e.isComposing || e.keyCode === 229) return;");
  });

  test("IssueList and PRList provide clearable IME-safe search and Clear filters recovery CTA", () => {
    for (const rel of ["views/issues/IssueList.tsx", "views/pulls/PRList.tsx"]) {
      const src = read(rel);
      expect(src).toContain("<h1 ");
      expect(src).toContain('aria-label="Clear search"');
      expect(src).toContain("if (e.isComposing || e.keyCode === 229) return;");
      expect(src).toContain("Clear filters");
    }
  });

  test("All repo sub-views and error/not-found routes expose a semantic h1", () => {
    for (const rel of [
      "views/code/DirectoryScreen.tsx",
      "views/code/BlobScreen.tsx",
      "views/code/CommitsScreen.tsx",
      "views/code/CompareScreen.tsx",
      "views/issues/IssueList.tsx",
      "views/pulls/PRList.tsx",
      "views/releases/index.tsx",
      "views/settings/layout.tsx",
    ]) {
      expect(read(rel)).toContain("<h1");
    }
    for (const rel of ["views/NotFound.tsx", "app/RouteError.tsx", "app/RepoLayout.tsx"]) {
      expect(read(rel)).toContain('headingLevel="h1"');
    }
  });
});
