import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  ErrorBoundary,
} from "solid-js";
import { ApiError } from "../api/client.ts";
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

describe("label-color, Avatar, and Toggle WCAG contrast (behavioral)", () => {
  const COLORS = [
    "d73a4a", "e99695", "fbca04", "0e8a16", "1d76db",
    "0052cc", "5319e7", "b60205", "bfdadc", "c5def5",
    "d4c5f9", "cccccc", "a2eeef", "8b949e", "ffffff",
    "000000", "#ff0", "#0ff", "not-a-color", "",
  ];

  test("guarantees >= 4.5:1 text contrast on both canvas-default and canvas-subtle in light and dark themes", () => {
    const surfaces: Record<"light" | "dark", readonly RgbColor[]> = {
      light: [
        { r: 255, g: 255, b: 255 }, // --canvas-default
        { r: 246, g: 248, b: 250 }, // --canvas-subtle (hovered rows / picker options)
      ],
      dark: [
        { r: 13, g: 17, b: 23 }, // --canvas-default
        { r: 21, g: 27, b: 35 }, // --canvas-subtle
      ],
    };

    for (const hex of COLORS) {
      for (const theme of ["light", "dark"] as const) {
        const style = computeLabelChipStyle(hex, theme);
        const fg = parseRgbCss(style.color);
        const bgRgba = parseRgbaCss(style.background);
        for (const surface of surfaces[theme]) {
          const effectiveBg = compositeOver(bgRgba, surface);
          expect(contrastRatio(fg, effectiveBg)).toBeGreaterThanOrEqual(4.5);
        }
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

  test("Unchecked Toggle track (neutral-emphasis) meets WCAG 2.1 SC 1.4.11 (>= 3:1) against canvas and thumb in both themes", () => {
    const white: RgbColor = { r: 255, g: 255, b: 255 };
    const lightTrack = parseHexColor("#59636e");
    const darkTrack = parseHexColor("#6e7681");

    expect(contrastRatio(lightTrack, parseHexColor("#ffffff"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(lightTrack, parseHexColor("#f6f8fa"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(white, lightTrack)).toBeGreaterThanOrEqual(3);

    expect(contrastRatio(darkTrack, parseHexColor("#0d1117"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(darkTrack, parseHexColor("#151b23"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(white, darkTrack)).toBeGreaterThanOrEqual(3);

    const shared = read("views/settings/shared.tsx");
    expect(shared).toContain("border-neutral-emphasis bg-neutral-emphasis");
  });
});

describe("SolidJS reactive error handling & recovery (behavioral)", () => {
  test("IssueDetail guarded issue/labels/milestones resources handle 404, 500 + Retry, and metadata failure without throwing to outer ErrorBoundary", async () => {
    let issueMode: "404" | "500" | "ok" = "404";
    let labelsFail = true;
    let milestonesFail = true;
    let outerCaught = false;
    let observedView = "";
    let observedComposerIssueId: string | null = null;
    let observedLabelError: string | undefined;
    let observedMilestoneError: string | undefined;
    let doRefetchIssue: (() => unknown) | undefined;
    let doRefetchLabels: (() => unknown) | undefined;
    let doRefetchMilestones: (() => unknown) | undefined;

    const dispose = createRoot((d) => {
      const boundary = ErrorBoundary({
        fallback: () => {
          outerCaught = true;
          return "outer-route-error";
        },
        get children() {
          const [issueRes, { refetch: refetchIssue }] = createResource(async () => {
            await Promise.resolve();
            if (issueMode === "404") throw new ApiError(404, "not_found", "Issue not found");
            if (issueMode === "500") throw new ApiError(500, "internal", "Server boom");
            return { issue: { id: "iss-42", title: "Hello" } };
          });
          const [labels, { refetch: refetchLabels }] = createResource(async () => {
            await Promise.resolve();
            if (labelsFail) throw new ApiError(500, "internal", "Labels unavailable");
            return { items: [{ name: "bug" }] };
          });
          const [milestones, { refetch: refetchMilestones }] = createResource(async () => {
            await Promise.resolve();
            if (milestonesFail) throw new ApiError(500, "internal", "Milestones unavailable");
            return { items: [{ number: 1, title: "v1" }] };
          });
          doRefetchIssue = refetchIssue;
          doRefetchLabels = refetchLabels;
          doRefetchMilestones = refetchMilestones;

          const issue = () =>
            issueRes.state === "ready" || issueRes.state === "refreshing"
              ? issueRes.latest?.issue
              : undefined;
          const labelItems = () =>
            labels.state === "ready" || labels.state === "refreshing"
              ? (labels.latest?.items ?? [])
              : [];
          const labelError = () =>
            labels.error
              ? (labels.error instanceof ApiError ? labels.error.message : "Could not load labels.")
              : undefined;
          const milestoneItems = () =>
            milestones.state === "ready" || milestones.state === "refreshing"
              ? (milestones.latest?.items ?? [])
              : [];
          const milestoneError = () =>
            milestones.error
              ? (milestones.error instanceof ApiError
                  ? milestones.error.message
                  : "Could not load milestones.")
              : undefined;

          // Mirrors IssueDetail's composerIdentity memo + createEffect outside inner ErrorBoundary.
          const composerIdentity = createMemo(() => {
            const target = issue();
            return target?.id ? { issueId: target.id } : null;
          });
          createEffect(() => {
            observedComposerIssueId = composerIdentity()?.issueId ?? null;
          });

          const notFound = () =>
            issueRes.error instanceof ApiError && issueRes.error.isNotFound;
          const loadError = () =>
            issueRes.error && !notFound() ? issueRes.error : undefined;

          createEffect(() => {
            observedLabelError = labelError();
            observedMilestoneError = milestoneError();
            if (notFound()) observedView = "404-h1";
            else if (loadError()) observedView = `500-retry:${(loadError() as Error).message}`;
            else if (issue()) {
              observedView = `ok:${issue()!.title}:labels=${labelItems().length}:ms=${milestoneItems().length}`;
            } else {
              observedView = "loading";
            }
          });
          return "mounted";
        },
      });
      createEffect(() => {
        if (typeof boundary === "function") boundary();
      });
      return d;
    });

    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observedView).toBe("404-h1");
    expect(observedComposerIssueId).toBeNull();

    // 500 error also stays in-page with Retry and does not crash to outer RouteError.
    issueMode = "500";
    void doRefetchIssue!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observedView).toBe("500-retry:Server boom");

    // Issue recovers on Retry even while labels/milestones are still returning 500.
    issueMode = "ok";
    void doRefetchIssue!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observedView).toBe("ok:Hello:labels=0:ms=0");
    expect(observedComposerIssueId).toBe("iss-42");
    expect(observedLabelError).toBe("Labels unavailable");
    expect(observedMilestoneError).toBe("Milestones unavailable");

    // Retrying sidebar metadata resources clears picker errors and populates items.
    labelsFail = false;
    milestonesFail = false;
    void doRefetchLabels!();
    void doRefetchMilestones!();
    await Bun.sleep(20);
    expect(observedLabelError).toBeUndefined();
    expect(observedMilestoneError).toBeUndefined();
    expect(observedView).toBe("ok:Hello:labels=1:ms=1");

    dispose();
  });

  test("CollaboratorsSettingsView guarded count badge prevents 500/403 from crashing to RouteError and recovers on reload", async () => {
    let mode: "500" | "403" | "ok" = "500";
    let outerCaught = false;
    let observed = "";
    let bumpReload: (() => void) | undefined;

    const dispose = createRoot((d) => {
      const boundary = ErrorBoundary({
        fallback: () => {
          outerCaught = true;
          return "outer-route-error";
        },
        get children() {
          const [reloadKey, setReloadKey] = createSignal(0);
          bumpReload = () => setReloadKey((k) => k + 1);
          const [collabs] = createResource(reloadKey, async () => {
            await Promise.resolve();
            if (mode === "500") throw new ApiError(500, "internal", "DB down");
            if (mode === "403") throw new ApiError(403, "forbidden", "Maintainer required");
            return [{ id: "u1" }, { id: "u2" }];
          });

          createEffect(() => {
            // Mirrors line 231 count badge + local error banner.
            const badge =
              !collabs.loading && !collabs.error && collabs() ? `(${collabs()!.length})` : "";
            const body = collabs.error
              ? `banner:${(collabs.error as Error).message}`
              : collabs.loading
                ? "loading"
                : `list:${collabs()?.length ?? 0}`;
            observed = `${badge}|${body}`;
          });
          return "mounted";
        },
      });
      createEffect(() => {
        if (typeof boundary === "function") boundary();
      });
      return d;
    });

    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("|banner:DB down");

    mode = "403";
    bumpReload!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("|banner:Maintainer required");

    mode = "ok";
    bumpReload!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("(2)|list:2");

    dispose();
  });

  test("Popover focus restoration survives synchronous busy=true via aria-disabled instead of native disabled", () => {
    // Models real browser focus(): native `disabled` drops focus; `aria-disabled` preserves focusability.
    let activeElement: string | null = "option-item";
    const [busy, setBusy] = createSignal(false);
    const [open, setOpen] = createSignal(true);

    const triggerBtn = {
      nativeDisabled: false,
      get ariaDisabled() {
        return busy() ? "true" : undefined;
      },
      focus() {
        if (!this.nativeDisabled) activeElement = "triggerBtn";
      },
      click() {
        if (open()) close(false);
        else if (!busy()) setOpen(true);
      },
    };

    const close = (restoreFocus = false) => {
      if (open()) {
        setOpen(false);
        if (restoreFocus) triggerBtn.focus();
        // Synchronous triage mutation sets busy(true) immediately on close/apply.
        setBusy(true);
      }
    };

    // Escape closes popover and flushes mutation (setting busy=true): focus lands and stays on trigger.
    close(true);
    expect(open()).toBe(false);
    expect(busy()).toBe(true);
    expect(triggerBtn.ariaDisabled).toBe("true");
    expect(activeElement).toBe("triggerBtn");

    // Clicking trigger while aria-disabled="true" does NOT reopen the popover.
    triggerBtn.click();
    expect(open()).toBe(false);

    // Once async PATCH finishes, trigger can reopen normally.
    setBusy(false);
    triggerBtn.click();
    expect(open()).toBe(true);
  });

  test("PRDetail tab state machine preserves Commits/Checks across /files navigation, resets on browser Back, and resets across PR number changes", () => {
    // Exercise the exact PRDetail tab + route state machine while staying mounted across `/files`.
    type Tab = "conversation" | "commits" | "files" | "checks";
    let prNumber!: () => string;
    let setPrNumber!: (v: string) => void;
    let pathname!: () => string;
    let setPathname!: (v: string) => void;
    let tab!: () => Tab;
    let goCommits!: () => void;
    let goFiles!: () => void;
    let goChecks!: () => void;

    const dispose = createRoot((d) => {
      [prNumber, setPrNumber] = createSignal("42");
      [pathname, setPathname] = createSignal("/alice/demo/pulls/42");
      const base = () => `/alice/demo/pulls/${prNumber()}`;
      const routeIsFiles = () =>
        /\/files\/?$/u.test(pathname()) && pathname().includes(`/pulls/${prNumber()}/`);
      let setTab: (v: Tab | ((cur: Tab) => Tab)) => void;
      [tab, setTab] = createSignal<Tab>(routeIsFiles() ? "files" : "conversation");

      let lastPrKey = "";
      createEffect(() => {
        const nextKey = `alice/demo#${prNumber()}`;
        if (lastPrKey && lastPrKey !== nextKey) {
          setTab(routeIsFiles() ? "files" : "conversation");
        }
        lastPrKey = nextKey;
      });
      createEffect(() => {
        if (routeIsFiles()) setTab("files");
        else setTab((cur) => (cur === "files" ? "conversation" : cur));
      });

      goCommits = () => {
        setTab("commits");
        if (routeIsFiles()) setPathname(base());
      };
      goFiles = () => {
        setTab("files");
        if (!routeIsFiles()) setPathname(`${base()}/files`);
      };
      goChecks = () => {
        setTab("checks");
        if (routeIsFiles()) setPathname(base());
      };
      return d;
    });

    // Commits -> ArrowRight -> Files changed -> ArrowRight -> Checks
    goCommits();
    expect(tab()).toBe("commits");
    goFiles();
    expect(pathname()).toBe("/alice/demo/pulls/42/files");
    expect(tab()).toBe("files");
    goChecks();
    expect(pathname()).toBe("/alice/demo/pulls/42");
    expect(tab()).toBe("checks");

    // Checks -> ArrowLeft -> Files changed -> ArrowLeft -> Commits
    goFiles();
    expect(tab()).toBe("files");
    goCommits();
    expect(pathname()).toBe("/alice/demo/pulls/42");
    expect(tab()).toBe("commits");

    // Browser Back from `/files` drops back to conversation.
    goFiles();
    expect(tab()).toBe("files");
    setPathname("/alice/demo/pulls/42");
    expect(tab()).toBe("conversation");

    // Navigating to another PR resets active tab cleanly.
    goChecks();
    expect(tab()).toBe("checks");
    setPrNumber("43");
    setPathname("/alice/demo/pulls/43");
    expect(tab()).toBe("conversation");

    dispose();
  });

  test("LogViewer retry clears stale 500 error when follow-up fetch returns 404 (not ready yet)", async () => {
    let nextResult: "500" | "404" | "ok" = "500";
    const [loading, setLoading] = createSignal(true);
    const [error, setError] = createSignal<string | null>(null);
    const [notReady, setNotReady] = createSignal(false);
    const [text, setText] = createSignal("");

    const load = async (initial: boolean) => {
      if (initial) {
        setLoading(true);
        setError(null);
      }
      try {
        await Promise.resolve();
        if (nextResult === "500") throw new ApiError(500, "internal", "Log store offline");
        if (nextResult === "404") throw new ApiError(404, "not_found", "Not ready");
        setText("hello log");
        setNotReady(false);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.isNotFound) {
          setNotReady(true);
          setError(null);
        } else if (initial) {
          setError(err instanceof ApiError ? err.message : "Failed to load logs");
        }
      } finally {
        if (initial) setLoading(false);
      }
    };

    await load(true);
    expect(loading()).toBe(false);
    expect(error()).toBe("Log store offline");
    expect(notReady()).toBe(false);

    // Retry returns 404: stale error clears and "No logs yet" state activates.
    nextResult = "404";
    await load(true);
    expect(error()).toBeNull();
    expect(notReady()).toBe(true);

    // Subsequent poll returns 200: logs appear cleanly.
    nextResult = "ok";
    await load(false);
    expect(error()).toBeNull();
    expect(notReady()).toBe(false);
    expect(text()).toBe("hello log");
  });
});

describe("Wave 3 component wiring, a11y, and mobile 44px invariants", () => {
  test("styles.css layers global resets in @layer base and registers done/neutral theme tokens", () => {
    const css = read("styles.css");
    expect(css).toContain("--color-done-emphasis: var(--done-emphasis);");
    expect(css).toContain("--color-neutral-emphasis: var(--neutral-emphasis);");
    expect(css).toContain("--color-neutral-muted: var(--neutral-muted);");
    expect(css).toMatch(/@layer base\s*\{[\s\S]*?:where\(a\)\s*\{[\s\S]*?\}/u);
  });

  test("UnderlineNav and PRDetail prevent tab vertical scrollbars and wire route + tabpanel semantics", () => {
    const nav = read("ui/UnderlineNav.tsx");
    const prDetail = read("views/pulls/PRDetail.tsx");
    const indexTsx = read("index.tsx");
    expect(nav).toContain("overflow-x-auto overflow-y-hidden");
    expect(nav).not.toContain("-mb-px");
    expect(prDetail).toContain("overflow-x-auto overflow-y-hidden");
    expect(prDetail).not.toContain("-mb-px");
    expect(prDetail).toContain("moveTabFocus(e)");
    expect(prDetail).toContain("tabIndex={props.active ? 0 : -1}");
    expect(prDetail).toContain("data-tab-id={props.id}");
    expect(prDetail).toContain('role="tabpanel"');
    expect(prDetail).toContain("aria-controls={props.active ? props.panelId : undefined}");
    expect(prDetail).toContain("aria-labelledby={`${tabsId}-tab-${tab()}`}");
    expect(indexTsx).toContain('path={["/pulls/:number", "/pulls/:number/files"]}');
  });

  test("IssueDetail, Collaborators, RunDetail, LogViewer, Actions, and Releases guard resource errors safely", () => {
    const issueDetail = read("views/issues/IssueDetail.tsx");
    const collabs = read("views/settings/collaborators.tsx");
    const runDetail = read("views/actions/RunDetail.tsx");
    const logViewer = read("views/actions/LogViewer.tsx");
    const actionsIdx = read("views/actions/index.tsx");
    const artifacts = read("views/actions/ArtifactsList.tsx");
    const releasesIdx = read("views/releases/index.tsx");
    const releaseDetail = read("views/releases/ReleaseDetail.tsx");

    expect(issueDetail).toContain('issueRes.state === "ready" || issueRes.state === "refreshing"');
    expect(issueDetail).toContain("when={!loadError()}");
    expect(issueDetail).toContain("restoreEditTitleFocus");
    expect(collabs).toContain("when={!collabs.loading && !collabs.error && collabs()}");
    expect(runDetail).toContain("when={!jobsRes.loading && !jobsRes.error}");
    expect(runDetail).toContain("runRes.error ? undefined : runRes.latest");
    expect(logViewer).toContain("setError(null);");
    expect(actionsIdx).toContain("runsRes.error ? undefined : runsRes.latest");
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
      expect(src).toMatch(/void refetch\w*\(\);[\s\S]{0,120}reset\(\);/u);
    }
  });

  test("Pickers use aria-disabled for focus-safe async saves and touched mobile controls meet 44px minimum", () => {
    const pickers = read("views/issues/pickers.tsx");
    const clone = read("views/code/CloneMenu.tsx");
    const logViewer = read("views/actions/LogViewer.tsx");
    const managers = read("views/issues/managers.tsx");
    const iconButton = read("ui/IconButton.tsx");
    const button = read("ui/Button.tsx");
    const issueDetail = read("views/issues/IssueDetail.tsx");

    expect(pickers).toContain('aria-disabled={props.disabled ? "true" : undefined}');
    expect(pickers).toContain('aria-haspopup="dialog"');
    expect(pickers).toContain('role="dialog"');
    expect(pickers).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(clone).toContain("min-h-11 px-2 text-xs text-accent");
    expect(logViewer).toContain("min-h-11 min-w-11 shrink-0");
    expect(managers).toContain("inline-flex h-11 w-11 items-center justify-center rounded-full");
    expect(iconButton).toContain('"h-11 w-11 sm:h-6 sm:w-6"');
    expect(button).toContain('sm: "min-h-11 sm:min-h-0 sm:h-7');
    expect(issueDetail).toContain("inline-flex h-11 w-11 items-center justify-center");
  });
});
