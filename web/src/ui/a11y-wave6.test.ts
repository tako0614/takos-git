import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RepositoryDto } from "../api/types.ts";
import { formatDocumentTitle } from "../lib/document-title.ts";
import { filterRepositories } from "../views/home/filter-repos.ts";
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

describe("Wave 6 Home repository filter & Release detail title (behavioral)", () => {
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

  test("inline editor Escape in LabelManager/MilestoneManager sets defaultPrevented so outer Dialog stays open", () => {
    const doc = { body: { style: { overflow: "" } } } as unknown as Document;
    const token = Symbol("manager-dialog");
    let dialogClosed = 0;
    let editing: string | null = "bug";
    pushDialog(token, doc);
    try {
      let prevented = false;
      let stopped = false;
      const esc = {
        key: "Escape",
        isComposing: false,
        keyCode: 27,
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

      if (!esc.isComposing && esc.keyCode !== 229 && esc.key === "Escape" && editing) {
        esc.preventDefault();
        esc.stopPropagation();
        editing = null;
      }
      expect(editing).toBeNull();
      expect(stopped).toBe(true);
      handleDialogKeyDown(token, esc, undefined, () => { dialogClosed += 1; }, doc);
      expect(dialogClosed).toBe(0);
    } finally {
      popDialog(token, doc);
    }
  });
});

describe("Wave 6 UI/UX, mobile layout, a11y, and auth-gating invariants", () => {
  test("HomeView adds IME-safe clearable repository filter with empty recovery state", () => {
    const home = read("views/home/index.tsx");
    expect(home).toContain("filterRepositories");
    expect(home).toContain('placeholder="Find a repository…"');
    expect(home).toContain('aria-label="Clear repository filter"');
    expect(home).toContain("if (e.isComposing || e.keyCode === 229) return;");
    expect(home).toContain("No matching repositories");
    expect(home).toContain("Clear filter");
  });

  test("IssueList exposes per-chip remove buttons with 44px mobile targets and active dropdown checkmarks", () => {
    const issues = read("views/issues/IssueList.tsx");
    expect(issues).toContain("Remove label filter: ${l()}");
    expect(issues).toContain("Remove milestone filter: ${activeMilestoneLabel()}");
    expect(issues).toContain("Remove assignee filter: ${activeAssigneeLabel()}");
    expect(issues).toContain("onClick={() => pickLabel(undefined)}");
    expect(issues).toContain("onClick={() => pickMilestone(undefined)}");
    expect(issues).toContain("onClick={() => pickAssignee(undefined)}");
    expect(issues).toContain("h-11 w-11 items-center justify-center rounded-full");
    expect(issues).toContain("menuOption(");
  });

  test("ReleaseForm uses BranchCombobox with repo defaultBranch and MarkdownEditor for release notes", () => {
    const form = read("views/releases/ReleaseForm.tsx");
    const releases = read("views/releases/index.tsx");
    const appShell = read("app/AppShell.tsx");
    expect(releases).toContain('defaultBranch={repo.detail()?.defaultBranch ?? "main"}');
    expect(form).toContain("<BranchCombobox");
    expect(form).toContain("reposApi.branches(o, r)");
    expect(form).toContain('listboxLabel="Target branches"');
    expect(form).toContain("<MarkdownEditor");
    expect(form).toContain('editorLabel="Release notes editor"');
    expect(appShell).toContain("applyDocumentTitle(location.pathname, location.search)");
  });

  test("CommitRows and PRCommits stack cleanly on mobile so commit titles are never crushed", () => {
    for (const rel of ["views/code/CommitRows.tsx", "views/pulls/PRCommits.tsx"]) {
      const src = read(rel);
      expect(src).toContain("flex-col gap-2");
      expect(src).toContain("sm:flex-row sm:items-start");
      expect(src).toContain("inline-flex min-h-11 max-w-full items-center");
    }
  });

  test("LabelManager, MilestoneManager, ActionsView, and RunDetail gate write actions on auth and guard busy/inline Escape", () => {
    const managers = read("views/issues/managers.tsx");
    const actions = read("views/actions/index.tsx");
    const runDetail = read("views/actions/RunDetail.tsx");

    expect(managers).toContain("const canWrite = () => session.authenticated();");
    expect(managers).toContain("onClose={() => !busy() && props.onClose()}");
    expect(managers).toContain("on:keydown={(e) => {");
    expect(managers).toContain("setEditName(null);");
    expect(managers).toContain("setEditNumber(null);");
    expect(actions).toContain("when={session.authenticated()}");
    expect(actions).toContain("Could not load workflow list");
    expect(runDetail).toContain("when={session.authenticated()}");
  });

  test("MarkdownEditor wires WAI-ARIA tabpanel semantics and IssueDetail restores focus on body/comment edits", () => {
    const parts = read("views/issues/parts.tsx");
    const detail = read("views/issues/IssueDetail.tsx");

    expect(parts).toContain('role="tabpanel"');
    expect(parts).toContain("aria-controls={tab() === \"write\" ? writePanelId : undefined}");
    expect(parts).toContain("aria-controls={tab() === \"preview\" ? previewPanelId : undefined}");
    expect(parts).toContain("aria-labelledby={tab() === \"write\" ? writeTabId : previewTabId}");
    expect(parts).toContain("Nothing to preview.");
    expect(detail).toContain("restoreEditBodyFocus");
    expect(detail).toContain("restoreActionsFocus");
    expect(detail).toContain("Updating…");
  });

  test("CloneMenu clamps to viewport and focuses URL input; ConflictResolver, PRChecks, Settings, Links, and mobile targets fixed", () => {
    const clone = read("views/code/CloneMenu.tsx");
    const conflict = read("views/pulls/ConflictResolver.tsx");
    const checks = read("views/pulls/PRChecks.tsx");
    const general = read("views/settings/general.tsx");
    const branches = read("views/settings/branches.tsx");
    const webhooks = read("views/settings/webhooks.tsx");
    const link = read("ui/Link.tsx");
    const markdown = read("ui/Markdown.tsx");

    expect(clone).toContain("computeHorizontalShift");
    expect(clone).toContain("viewportWidth()");
    expect(clone).toContain("urlInputEl?.focus()");
    expect(conflict).toContain('aria-pressed={currentResolution()?.source === "ours"}');
    expect(conflict).toContain("Unapplied edits");
    expect(checks).toContain("/commit/${props.sha}");
    expect(checks).toContain("min-h-11 min-w-11");
    expect(general).toContain("onClose={() => !savingVis() && setVisOpen(false)}");
    expect(branches).toContain("Created rule for");
    expect(branches).toContain("setDeletingPattern(null)");
    expect(webhooks).toContain('role="img"');
    expect(webhooks).toContain("setDeletingId(null)");
    expect(link).toContain("tg-focus rounded");
    expect(markdown).toContain("tg-focus rounded");
  });
});
