import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeLabelChipStyle,
  contrastRatio,
  parseHexColor,
  type RgbColor,
} from "../lib/label-color.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

function parseRgbCss(css: string): RgbColor {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/u.exec(css.trim());
  if (!m) throw new Error(`Expected rgb(...) string, got: ${css}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function parseRgbaCss(css: string): RgbColor & { a: number } {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/u.exec(css.trim());
  if (!m) throw new Error(`Expected rgba(...) string, got: ${css}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
}

function compositeOver(fg: RgbColor & { a: number }, bg: RgbColor): RgbColor {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
  };
}

describe("label-color WCAG AA contrast (behavioral)", () => {
  const COLORS = [
    "d73a4a", "e99695", "fbca04", "0e8a16", "1d76db",
    "0052cc", "5319e7", "b60205", "bfdadc", "c5def5",
    "d4c5f9", "cccccc", "a2eeef", "ffffff", "000000",
    "#ff0", "#0ff", "not-a-color", "",
  ];

  test("guarantees >= 4.5:1 text contrast on both light and dark canvases for any label hex", () => {
    const lightCanvas: RgbColor = { r: 255, g: 255, b: 255 };
    const darkCanvas: RgbColor = { r: 13, g: 17, b: 23 };

    for (const hex of COLORS) {
      for (const theme of ["light", "dark"] as const) {
        const style = computeLabelChipStyle(hex, theme);
        const fg = parseRgbCss(style.color);
        const bgRgba = parseRgbaCss(style.background);
        const effectiveBg = compositeOver(bgRgba, theme === "dark" ? darkCanvas : lightCanvas);
        const ratio = contrastRatio(fg, effectiveBg);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("Avatar palette entries all meet WCAG AA (>= 4.5:1) contrast against white text", () => {
    const avatarSrc = read("ui/Avatar.tsx");
    const matches = Array.from(avatarSrc.matchAll(/#[0-9a-fA-F]{6}/gu)).map((m) => m[0]);
    expect(matches.length).toBeGreaterThanOrEqual(8);
    const white: RgbColor = { r: 255, g: 255, b: 255 };
    for (const hex of matches) {
      expect(contrastRatio(white, parseHexColor(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("CSS cascade layers, semantic tokens, and tab scrollbars", () => {
  test("styles.css layers global resets in @layer base and registers done/neutral theme tokens", () => {
    const css = read("styles.css");
    expect(css).toContain("--color-done-emphasis: var(--done-emphasis);");
    expect(css).toContain("--color-neutral-emphasis: var(--neutral-emphasis);");
    expect(css).toContain("--color-neutral-muted: var(--neutral-muted);");
    expect(css).toMatch(/@layer base\s*\{[\s\S]*?:where\(a\)\s*\{[\s\S]*?\}/u);
  });

  test("UnderlineNav and PRDetail prevent spurious vertical scrollbars on tab strips", () => {
    const nav = read("ui/UnderlineNav.tsx");
    const prDetail = read("views/pulls/PRDetail.tsx");
    expect(nav).toContain("overflow-x-auto overflow-y-hidden");
    expect(nav).not.toContain("-mb-px");
    expect(prDetail).toContain("overflow-x-auto overflow-y-hidden");
    expect(prDetail).not.toContain("-mb-px");
  });

  test("PRDetail tablist implements WAI-ARIA roving tabindex and arrow-key navigation", () => {
    const prDetail = read("views/pulls/PRDetail.tsx");
    expect(prDetail).toContain("moveTabFocus(e)");
    expect(prDetail).toContain("tabIndex={props.active ? 0 : -1}");
    expect(prDetail).toContain("data-tab-id={props.id}");
  });
});

describe("Wave 3 error recovery, resource safety, IME, and a11y invariants", () => {
  test("Actions and Releases views guard resource.latest against resource.error", () => {
    const actionsIdx = read("views/actions/index.tsx");
    const runDetail = read("views/actions/RunDetail.tsx");
    const artifacts = read("views/actions/ArtifactsList.tsx");
    const releasesIdx = read("views/releases/index.tsx");
    const releaseDetail = read("views/releases/ReleaseDetail.tsx");

    expect(actionsIdx).toContain("runsRes.error ? undefined : runsRes.latest");
    expect(actionsIdx).toContain("workflowsRes.error ? [] : (workflowsRes.latest ?? [])");
    expect(runDetail).toContain("runRes.error ? undefined : runRes.latest");
    expect(runDetail).toContain("jobsRes.error ? [] : (jobsRes.latest ?? [])");
    expect(runDetail).toContain("Couldn't load workflow run");
    expect(artifacts).toContain("when={!artifacts.error}");
    expect(releasesIdx).toContain("page.error ? undefined : page.latest");
    expect(releaseDetail).toContain("release.error ? undefined : release.latest");
  });

  test("Detail-view ErrorBoundary retry buttons call refetch before reset", () => {
    for (const rel of [
      "views/issues/IssueDetail.tsx",
      "views/pulls/PRDetail.tsx",
      "views/pulls/PRCommits.tsx",
      "views/pulls/PRChecks.tsx",
      "views/pulls/ConflictResolver.tsx",
    ]) {
      const src = read(rel);
      expect(src).not.toMatch(/reset\(\);\s*void refetch/u);
      expect(src).toMatch(/void refetch\w*\(\);[\s\S]{0,60}reset\(\);/u);
    }
  });

  test("IssueDetail, pickers, Menu, CloneMenu, and ConflictResolver enforce IME safety and accessible labels", () => {
    const issueDetail = read("views/issues/IssueDetail.tsx");
    const pickers = read("views/issues/pickers.tsx");
    const menu = read("ui/Menu.tsx");
    const clone = read("views/code/CloneMenu.tsx");
    const resolver = read("views/pulls/ConflictResolver.tsx");
    const settingsShared = read("views/settings/shared.tsx");

    expect(issueDetail).toContain('aria-label="Issue title"');
    expect(issueDetail).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(pickers).toContain('aria-haspopup="dialog"');
    expect(pickers).toContain('role="dialog"');
    expect(pickers).toContain("aria-controls={open() ? panelId : undefined}");
    expect(pickers).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(pickers).toContain('aria-label="Add assignee by subject ID"');
    expect(menu).toContain("e.stopPropagation();");
    expect(clone).toContain('aria-haspopup="dialog"');
    expect(clone).toContain('role="dialog"');
    expect(clone).toContain("e.stopPropagation();");
    expect(clone).not.toContain('id="clone-url"');
    expect(resolver).toContain("<label for={resolvedId}>");
    expect(resolver).toContain("flex-col gap-3 md:flex-row");
    expect(settingsShared).toContain("createUniqueId()");
    expect(settingsShared).not.toContain("Math.random()");
  });

  test("Fallback and 404 detail states expose a semantic h1", () => {
    expect(read("views/issues/index.tsx")).toContain("<h1 ");
    for (const rel of [
      "views/issues/IssueDetail.tsx",
      "views/pulls/PRDetail.tsx",
      "views/code/CommitDetailScreen.tsx",
      "views/actions/RunDetail.tsx",
      "views/releases/ReleaseDetail.tsx",
    ]) {
      expect(read(rel)).toContain('headingLevel="h1"');
    }
  });
});
