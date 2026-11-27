import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRefSelectorKey } from "../views/code/ref-selector-a11y.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

describe("RefSelector keyboard navigation (behavioral)", () => {
  test("ArrowDown and ArrowUp wrap around items and Enter picks active index", () => {
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 3, -1, true))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 3, 2, true))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "ArrowUp", isComposing: false, keyCode: 38 }, 3, -1, true))
      .toEqual({ type: "move", index: 2 });
    expect(resolveRefSelectorKey({ key: "ArrowUp", isComposing: false, keyCode: 38 }, 3, 0, true))
      .toEqual({ type: "move", index: 2 });
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: false, keyCode: 13 }, 3, 1, true))
      .toEqual({ type: "pick", index: 1 });
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: false, keyCode: 13 }, 3, -1, true))
      .toEqual({ type: "none" });
  });

  test("Home/End navigate outside filter input without hijacking text caret in input", () => {
    expect(resolveRefSelectorKey({ key: "Home", isComposing: false, keyCode: 36 }, 4, 2, true))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "End", isComposing: false, keyCode: 35 }, 4, 1, true))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "Home", isComposing: false, keyCode: 36 }, 4, 2, false))
      .toEqual({ type: "move", index: 0 });
    expect(resolveRefSelectorKey({ key: "End", isComposing: false, keyCode: 35 }, 4, 1, false))
      .toEqual({ type: "move", index: 3 });
  });

  test("IME composition events and empty lists are ignored", () => {
    expect(resolveRefSelectorKey({ key: "Enter", isComposing: true, keyCode: 13 }, 3, 0, true))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 229 }, 3, 0, true))
      .toEqual({ type: "none" });
    expect(resolveRefSelectorKey({ key: "ArrowDown", isComposing: false, keyCode: 40 }, 0, -1, true))
      .toEqual({ type: "none" });
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
    expect(prFiles).toContain("(e.ctrlKey || e.metaKey) && e.key === \"Enter\"");
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
