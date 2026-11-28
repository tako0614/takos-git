import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  children as resolveChildren,
  createEffect,
  createResource,
  createRoot,
  createSignal,
  Show,
  type JSX,
} from "solid-js";
import type { RepositoryDto } from "../api/types.ts";
import {
  createOneShotFocus,
  focusConnected,
  handleInlineEditEscape,
  moveTabFocus,
  type FocusableLike,
} from "../lib/a11y.ts";
import { formatDocumentTitle } from "../lib/document-title.ts";
import { filterRepositories } from "../views/home/filter-repos.ts";
import { hasUnappliedConflictEdit, type Resolution } from "../views/pulls/types.ts";
import { handleDialogKeyDown, popDialog, pushDialog } from "./dialog-a11y.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

function makeRepo(overrides: Partial<RepositoryDto>): RepositoryDto {
  return {
    id: "r1",
    owner: "alice",
    name: "demo",
    fullName: "alice/demo",
    description: null,
    visibility: "public",
    defaultBranch: "main",
    isArchived: false,
    forkOf: null,
    cloneUrl: "https://git.example.invalid/alice/demo.git",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeFakeFocusable(opts: { isConnected?: boolean; disabled?: boolean } = {}): FocusableLike & {
  focused: number;
  isConnected: boolean;
  disabled: boolean;
} {
  return {
    focused: 0,
    isConnected: opts.isConnected ?? true,
    disabled: opts.disabled ?? false,
    focus() {
      if (this.isConnected && !this.disabled) this.focused += 1;
    },
  };
}

function makeEscEvent(overrides: Partial<{ key: string; isComposing: boolean; keyCode: number }> = {}) {
  let prevented = false;
  let stopped = false;
  const event = {
    key: overrides.key ?? "Escape",
    isComposing: overrides.isComposing ?? false,
    keyCode: overrides.keyCode ?? 27,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  } as unknown as KeyboardEvent;
  return { event, wasPrevented: () => prevented, wasStopped: () => stopped };
}

describe("Wave 6 behavioral tests", () => {
  const repos: readonly RepositoryDto[] = [
    makeRepo({ id: "1", owner: "alice", name: "demo", fullName: "alice/demo", description: "Collaborative hosting", visibility: "public", defaultBranch: "main" }),
    makeRepo({ id: "2", owner: "alice", name: "edge-telemetry", fullName: "alice/edge-telemetry", description: "Workers observability", visibility: "private", defaultBranch: "trunk" }),
    makeRepo({ id: "3", owner: "team-infra", name: "design-tokens", fullName: "team-infra/design-tokens", description: "WCAG color scales", visibility: "internal", defaultBranch: "main" }),
  ];

  test("filterRepositories matches owner/name, description, visibility, and defaultBranch case-insensitively", () => {
    expect(filterRepositories(repos, "")).toHaveLength(3);
    expect(filterRepositories(repos, "   ")).toHaveLength(3);
    expect(filterRepositories(repos, "TEAM-INFRA/design").map((r) => r.id)).toEqual(["3"]);
    expect(filterRepositories(repos, "observability").map((r) => r.id)).toEqual(["2"]);
    expect(filterRepositories(repos, "private").map((r) => r.id)).toEqual(["2"]);
    expect(filterRepositories(repos, "trunk").map((r) => r.id)).toEqual(["2"]);
    expect(filterRepositories(repos, "nonexistent")).toHaveLength(0);
  });

  test("formatDocumentTitle includes ?tag= on Releases detail routes while preserving list title", () => {
    expect(formatDocumentTitle("/alice/demo/releases")).toBe("Releases · alice/demo — Takos Git");
    expect(formatDocumentTitle("/alice/demo/releases", "?tag=v1.2.0")).toBe("Release v1.2.0 · alice/demo — Takos Git");
    expect(formatDocumentTitle("/alice/demo/releases", "?tag=release%2Fv2.0")).toBe("Release release/v2.0 · alice/demo — Takos Git");
    expect(formatDocumentTitle("/alice/demo/releases", "?tag=%20%20")).toBe("Releases · alice/demo — Takos Git");
  });

  test("HomeView error/loading/empty reactive branches render error banner on API 500 instead of empty state and recover on retry", async () => {
    let mode: "error" | "list" | "empty" = "error";
    let triggerRefetch!: () => unknown;
    let rendered = "";

    const dispose = createRoot((d) => {
      const [data, { refetch }] = createResource(async () => {
        await Promise.resolve();
        if (mode === "error") throw new Error("HTTP 500 outage");
        if (mode === "empty") return { items: [] as readonly RepositoryDto[], nextCursor: null };
        return { items: repos, nextCursor: null };
      });
      triggerRefetch = refetch;

      const pageData = () => (data.error ? undefined : data.latest);
      const items = () => pageData()?.items ?? [];

      const view = Show({
        get when() {
          return !data.error;
        },
        get fallback() {
          return `error:${data.error instanceof Error ? data.error.message : "unknown"}`;
        },
        get children() {
          return Show({
            get when() {
              return !data.loading || pageData();
            },
            fallback: "loading",
            get children() {
              return Show({
                get when() {
                  return items().length > 0;
                },
                fallback: "empty:No repositories yet",
                get children() {
                  return `list:${items().length}`;
                },
              });
            },
          });
        },
      });

      const resolveOutput = (node: unknown): string => {
        let cur = node;
        while (typeof cur === "function") cur = (cur as () => unknown)();
        return String(cur);
      };

      createEffect(() => {
        rendered = resolveOutput(view);
      });
      return d;
    });

    await Bun.sleep(20);
    expect(rendered).toBe("error:HTTP 500 outage");

    mode = "list";
    void triggerRefetch();
    await Bun.sleep(20);
    expect(rendered).toBe("list:3");

    mode = "empty";
    void triggerRefetch();
    await Bun.sleep(20);
    expect(rendered).toBe("empty:No repositories yet");

    dispose();
  });

  test("TimelineComment children() evaluates headerActions once per edit toggle so actionsContainer stays connected", () => {
    let mounts = 0;
    let activeContainer: { button: ReturnType<typeof makeFakeFocusable>; mounted: boolean } | undefined;
    let setEditing!: (v: boolean) => void;
    let renderedSpan: unknown = null;

    const dispose = createRoot((d) => {
      const [editing, _setEditing] = createSignal(false);
      setEditing = _setEditing;

      // Mirrors CommentItem passing <Show when={!editing()}>...</Show> into TimelineComment
      const headerActionsProp = (): JSX.Element =>
        Show({
          get when() {
            return !editing();
          },
          get children() {
            mounts += 1;
            const node = { button: makeFakeFocusable({ isConnected: true }), mounted: false };
            activeContainer = node;
            return node as unknown as JSX.Element;
          },
        }) as unknown as JSX.Element;

      const headerActions = resolveChildren(headerActionsProp);
      const slot = Show({
        get when() {
          return headerActions();
        },
        children: (actions) => {
          const el = actions() as unknown as { button: ReturnType<typeof makeFakeFocusable>; mounted: boolean };
          el.mounted = true;
          return el as unknown as JSX.Element;
        },
      });

      createEffect(() => {
        renderedSpan = typeof slot === "function" ? slot() : slot;
      });
      return d;
    });

    expect(mounts).toBe(1);
    expect(activeContainer?.mounted).toBe(true);
    expect(renderedSpan).toBe(activeContainer);

    // Enter edit mode -> unmounts header actions.
    setEditing(true);
    expect(renderedSpan).toBeUndefined();
    expect(mounts).toBe(1);

    // Exit edit mode (Cancel or Save) -> creates exactly one new connected node (no detached overwrite).
    setEditing(false);
    expect(mounts).toBe(2);
    expect(activeContainer?.mounted).toBe(true);
    expect(renderedSpan).toBe(activeContainer);
    expect(focusConnected(activeContainer?.button)).toBe(true);
    expect(activeContainer?.button.focused).toBe(1);

    dispose();
  });

  test("createOneShotFocus focuses MarkdownEditor textarea once on open and does not steal focus on Preview -> Write tab switch", async () => {
    const editorFocus = createOneShotFocus<ReturnType<typeof makeFakeFocusable>>();
    const firstTextarea = makeFakeFocusable();
    const remountedTextarea = makeFakeFocusable();
    const writeTab = {
      dataset: { tabId: "write" },
      focused: 0,
      focus() {
        this.focused += 1;
      },
      closest() {
        return tablist;
      },
    };
    const previewTab = {
      dataset: { tabId: "preview" },
      focused: 0,
      focus() {
        this.focused += 1;
      },
      closest() {
        return tablist;
      },
    };
    const tablist = {
      querySelectorAll() {
        return [writeTab, previewTab];
      },
    };

    // 1. Opening edit mode arms one-shot focus -> focuses textarea once.
    editorFocus.arm();
    editorFocus.ref(firstTextarea);
    await Promise.resolve();
    expect(firstTextarea.focused).toBe(1);

    // 2. Switching Write -> Preview -> Write with arrow keys remounts textarea without stealing tab focus.
    const toPreview = moveTabFocus({
      key: "ArrowRight",
      currentTarget: writeTab,
      preventDefault() {},
    } as unknown as KeyboardEvent);
    expect(toPreview).toBe("preview");
    expect(previewTab.focused).toBe(1);

    const backToWrite = moveTabFocus({
      key: "ArrowLeft",
      currentTarget: previewTab,
      preventDefault() {},
    } as unknown as KeyboardEvent);
    expect(backToWrite).toBe("write");
    expect(writeTab.focused).toBe(1);

    editorFocus.ref(remountedTextarea);
    await Promise.resolve();
    expect(remountedTextarea.focused).toBe(0);

    // 3. Disconnected elements are ignored even when armed; re-opening edit re-arms cleanly.
    const detached = makeFakeFocusable({ isConnected: false });
    editorFocus.arm();
    editorFocus.ref(detached);
    await Promise.resolve();
    expect(detached.focused).toBe(0);

    const nextSessionTextarea = makeFakeFocusable();
    editorFocus.arm();
    editorFocus.ref(nextSessionTextarea);
    await Promise.resolve();
    expect(nextSessionTextarea.focused).toBe(1);
  });

  test("handleInlineEditEscape guards busy saves, keeps outer Dialog open, ignores IME, and focusConnected restores focus inside modal", () => {
    const doc = { body: { style: { overflow: "" } } } as unknown as Document;
    const token = Symbol("manager-dialog");
    let dialogClosed = 0;
    let cancelCount = 0;
    pushDialog(token, doc);
    try {
      // 1. While busy() is true, Escape stops propagation and prevents Dialog close WITHOUT cancelling edit.
      const busyEsc = makeEscEvent();
      expect(handleInlineEditEscape(busyEsc.event, true, () => { cancelCount += 1; })).toBe(true);
      expect(busyEsc.wasPrevented()).toBe(true);
      expect(busyEsc.wasStopped()).toBe(true);
      expect(cancelCount).toBe(0);
      handleDialogKeyDown(token, busyEsc.event, undefined, () => { dialogClosed += 1; }, doc);
      expect(dialogClosed).toBe(0);

      // 2. IME composition Escape is ignored.
      const imeEsc = makeEscEvent({ isComposing: true });
      expect(handleInlineEditEscape(imeEsc.event, false, () => { cancelCount += 1; })).toBe(false);
      expect(imeEsc.wasPrevented()).toBe(false);
      expect(cancelCount).toBe(0);

      // 3. When idle, Escape cancels inline edit, keeps outer Dialog open, and restores focus inside dialog.
      const idleEsc = makeEscEvent();
      const editBtn = makeFakeFocusable({ isConnected: true });
      const dialogPanel = makeFakeFocusable({ isConnected: true });
      expect(
        handleInlineEditEscape(idleEsc.event, false, () => {
          cancelCount += 1;
          focusConnected(editBtn, dialogPanel);
        }),
      ).toBe(true);
      expect(cancelCount).toBe(1);
      expect(editBtn.focused).toBe(1);
      expect(dialogPanel.focused).toBe(0);
      handleDialogKeyDown(token, idleEsc.event, undefined, () => { dialogClosed += 1; }, doc);
      expect(dialogClosed).toBe(0);

      // 4. If row Edit button is disconnected or disabled, focusConnected falls back to dialog panel (never body).
      const detachedBtn = makeFakeFocusable({ isConnected: false });
      expect(focusConnected(detachedBtn, dialogPanel)).toBe(true);
      expect(detachedBtn.focused).toBe(0);
      expect(dialogPanel.focused).toBe(1);

      const disabledBtn = makeFakeFocusable({ isConnected: true, disabled: true });
      expect(focusConnected(disabledBtn, dialogPanel)).toBe(true);
      expect(disabledBtn.focused).toBe(0);
      expect(dialogPanel.focused).toBe(2);
    } finally {
      popDialog(token, doc);
    }
  });

  test("hasUnappliedConflictEdit flags post-delete edits until Apply edit is clicked", () => {
    const ours: Resolution = { path: "src/config.ts", content: "const port = 8080;", delete: false, source: "ours" };
    const del: Resolution = { path: "src/config.ts", content: "", delete: true, source: "delete" };
    const manual: Resolution = { path: "src/config.ts", content: "const port = 9001;", delete: false, source: "manual" };

    expect(hasUnappliedConflictEdit(undefined, "const port = 8080;", false)).toBe(true);
    expect(hasUnappliedConflictEdit(ours, "const port = 8080;", false)).toBe(false);
    expect(hasUnappliedConflictEdit(ours, "const port = 9000;", true)).toBe(true);
    expect(hasUnappliedConflictEdit(ours, "const port = 8080;", true)).toBe(false);

    // Clicking "Delete file" clears dirty -> no false unapplied badge.
    expect(hasUnappliedConflictEdit(del, "const port = 8080;", false)).toBe(false);
    // Editing textarea after "Delete file" sets dirty -> surfaces "Unapplied edits" and highlights "Apply edit".
    expect(hasUnappliedConflictEdit(del, "const port = 9001;", true)).toBe(true);
    expect(hasUnappliedConflictEdit(del, "", true)).toBe(true);
    // Clicking "Apply edit" saves manual resolution and clears dirty.
    expect(hasUnappliedConflictEdit(manual, "const port = 9001;", false)).toBe(false);
  });
});

describe("Wave 6 view wiring invariants", () => {
  test("HomeView wires explicit error fallback before empty state and IME-safe repo filter", () => {
    const home = read("views/home/index.tsx");
    expect(home).toContain("when={!data.error}");
    expect(home).toContain('title="Could not load repositories"');
    expect(home).toContain("filterRepositories");
    expect(home).toContain('aria-label="Clear repository filter"');
    expect(home).toContain("No matching repositories");
  });

  test("TimelineComment resolves headerActions once and IssueDetail uses one-shot focus + connected restore", () => {
    const parts = read("views/issues/parts.tsx");
    const detail = read("views/issues/IssueDetail.tsx");
    expect(parts).toContain("const headerActions = resolveChildren(() => props.headerActions);");
    expect(parts).toContain("<Show when={headerActions()}>");
    expect(parts).toContain('role="tabpanel"');
    expect(detail).toContain("createOneShotFocus<HTMLTextAreaElement>()");
    expect(detail).toContain("textareaRef={bodyEditorFocus.ref}");
    expect(detail).toContain("textareaRef={commentEditorFocus.ref}");
    expect(detail).toContain("focusConnected(");
  });

  test("LabelManager and MilestoneManager wire busy-safe inline Escape and modal focus restoration", () => {
    const managers = read("views/issues/managers.tsx");
    expect(managers).toContain("const canWrite = () => session.authenticated();");
    expect(managers).toContain("handleInlineEditEscape(e, busy(), () => cancelEdit(label().name))");
    expect(managers).toContain("handleInlineEditEscape(e, busy(), () => cancelEdit(m().number))");
    expect(managers).toContain("focusConnected(editButtons.get(");
  });

  test("IssueList, ReleaseForm, CommitRows, PRCommits, CloneMenu, ConflictResolver, PRChecks, Actions, Settings, and Links wiring", () => {
    const issues = read("views/issues/IssueList.tsx");
    const form = read("views/releases/ReleaseForm.tsx");
    const clone = read("views/code/CloneMenu.tsx");
    const conflict = read("views/pulls/ConflictResolver.tsx");
    const checks = read("views/pulls/PRChecks.tsx");
    const actions = read("views/actions/index.tsx");
    const runDetail = read("views/actions/RunDetail.tsx");

    expect(issues).toContain("Remove label filter: ${l()}");
    expect(issues).toContain("menuOption(");
    expect(form).toContain("<BranchCombobox");
    expect(form).toContain("<MarkdownEditor");
    expect(clone).toContain("min-h-11 min-w-0 flex-1");
    expect(clone).toContain("sm:min-h-0");
    expect(clone).toContain("computeHorizontalShift");
    expect(conflict).toContain("hasUnappliedConflictEdit(currentResolution(), edit(), editDirty())");
    expect(checks).toContain("/commit/${props.sha}");
    expect(actions).toContain("Could not load workflow list");
    expect(runDetail).toContain("when={session.authenticated()}");
    for (const rel of ["views/code/CommitRows.tsx", "views/pulls/PRCommits.tsx"]) {
      const src = read(rel);
      expect(src).toContain("flex-col gap-2");
      expect(src).toContain("sm:flex-row sm:items-start");
    }
  });
});
