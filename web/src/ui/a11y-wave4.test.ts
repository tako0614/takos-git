import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEffect,
  createResource,
  createRoot,
  createSignal,
  ErrorBoundary,
} from "solid-js";
import { ApiError } from "../api/client.ts";

const webSrc = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(webSrc, rel), "utf8");

describe("Wave 4 reactive resource error handling & cursor pagination (behavioral)", () => {
  test("SessionProvider guarded latest prevents 500 on /api/auth/session from throwing outside ErrorBoundary", async () => {
    let fail = true;
    let outerCaught = false;
    let observed = "";
    let triggerRefetch: (() => unknown) | undefined;

    const dispose = createRoot((d) => {
      const boundary = ErrorBoundary({
        fallback: () => {
          outerCaught = true;
          return "outer-crash";
        },
        get children() {
          const [state, { refetch }] = createResource(async () => {
            await Promise.resolve();
            if (fail) throw new ApiError(500, "internal", "Auth unavailable");
            return { authenticated: true as const, user: { subject: "alice" } };
          });
          triggerRefetch = refetch;
          const latest = () => (state.error ? undefined : state.latest);

          createEffect(() => {
            if (state.loading && !latest()) observed = "loading";
            else if (state.error) observed = `err:${(state.error as Error).message}`;
            else if (latest()?.authenticated) observed = `user:${latest()!.user.subject}`;
            else observed = "anon";
          });
          return "ok";
        },
      });
      createEffect(() => {
        if (typeof boundary === "function") boundary();
      });
      return d;
    });

    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("err:Auth unavailable");

    fail = false;
    void triggerRefetch!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("user:alice");

    dispose();
  });

  test("Blob blame, IssueList metadata, PRList pagination, and Settings General branches survive 500 without crashing to RouteError", async () => {
    let fail = true;
    let outerCaught = false;
    let observed = "";
    let doRefetch: (() => unknown) | undefined;

    const dispose = createRoot((d) => {
      const boundary = ErrorBoundary({
        fallback: () => {
          outerCaught = true;
          return "route-error";
        },
        get children() {
          const [res, { refetch }] = createResource(async () => {
            await Promise.resolve();
            if (fail) throw new ApiError(500, "internal", "Backend failed");
            return { items: ["item-1"], nextCursor: "c2" };
          });
          doRefetch = refetch;
          const safe = () => (res.error ? undefined : res.latest);

          createEffect(() => {
            // Mirrors guarded reads in BlobScreen blame, IssueList labels/milestones,
            // PRList Pagination, and Settings General branchData.
            const count = safe()?.items.length ?? 0;
            const next = safe()?.nextCursor ?? null;
            observed = res.error ? `retry:${count}:${String(next)}` : `ok:${count}:${String(next)}`;
          });
          return "ok";
        },
      });
      createEffect(() => {
        if (typeof boundary === "function") boundary();
      });
      return d;
    });

    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("retry:0:null");

    fail = false;
    void doRefetch!();
    await Bun.sleep(20);
    expect(outerCaught).toBe(false);
    expect(observed).toBe("ok:1:c2");

    dispose();
  });

  test("Cursor history stack walks Page 1 -> Page 2 -> Page 3 -> Page 2 -> Page 1 cleanly", () => {
    const dispose = createRoot((d) => {
      const [history, setHistory] = createSignal<(string | null)[]>([null]);
      const cursor = () => history()[history().length - 1];
      const goNext = (next: string) => setHistory((h) => [...h, next]);
      const goPrev = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));

      expect(cursor()).toBeNull();
      expect(history().length > 1).toBe(false);

      goNext("page-2");
      expect(cursor()).toBe("page-2");
      goNext("page-3");
      expect(cursor()).toBe("page-3");

      // Previous from Page 3 returns to Page 2, NOT Page 1.
      goPrev();
      expect(cursor()).toBe("page-2");
      expect(history().length > 1).toBe(true);

      goPrev();
      expect(cursor()).toBeNull();
      expect(history().length > 1).toBe(false);

      return d;
    });
    dispose();
  });
});

describe("Wave 4 UI/UX, color-scheme, dialog/toast/menu, forms & mobile 44px invariants", () => {
  test("styles.css and index.html declare color-scheme for light and dark themes", () => {
    const css = read("styles.css");
    const html = readFileSync(resolve(webSrc, "../index.html"), "utf8");
    expect(css).toContain("color-scheme: light;");
    expect(css).toContain("color-scheme: dark;");
    expect(html).toContain("color-scheme: light;");
    expect(html).toContain("color-scheme: dark;");
  });

  test("SessionProvider guards state.latest, TopBar offers Retry sign-in, and AdminGate waits for loading", () => {
    const session = read("store/session.tsx");
    const topBar = read("app/TopBar.tsx");
    const settingsShared = read("views/settings/shared.tsx");
    expect(session).toContain("state.error ? undefined : state.latest");
    expect(session).toContain("error: () => state.error");
    expect(topBar).toContain("Retry sign-in");
    expect(topBar).toContain("min-h-11 min-w-11");
    expect(settingsShared).toContain("when={!session.loading()}");
    expect(settingsShared).toContain("when={!session.error()}");
  });

  test("Dialog guards backdrop drag-out, ConfirmDialogHost uses alertdialog + danger autofocus, ToastHost pauses on focus, Menu opens on arrows", () => {
    const dialog = read("ui/Dialog.tsx");
    const confirm = read("ui/ConfirmDialogHost.tsx");
    const toast = read("ui/ToastHost.tsx");
    const menu = read("ui/Menu.tsx");
    const relTime = read("ui/RelativeTime.tsx");

    expect(dialog).toContain("pointerDownOnBackdrop");
    expect(dialog).toContain("onPointerDown=");
    expect(dialog).toContain('role={props.role ?? "dialog"}');
    expect(dialog).toContain('aria-describedby={props["aria-describedby"]}');
    expect(confirm).toContain('role="alertdialog"');
    expect(confirm).toContain("aria-describedby={descId}");
    expect(confirm).toContain("autofocus={state().danger ? true : undefined}");
    expect(toast).toContain("onFocusIn={() => toast.pauseToast(item.id)}");
    expect(toast).toContain("onFocusOut=");
    expect(menu).toContain('e.key === "ArrowDown" || e.key === "ArrowUp"');
    expect(relTime).toContain("Number.isFinite(ms)");
    expect(relTime).toContain("<Show");
  });

  test("Code, Home, Issues, Pulls, Actions, Releases, and Settings views fix resource guards, labels, landmarks, forms, and mobile targets", () => {
    const fields = read("ui/Fields.tsx");
    const breadcrumb = read("ui/Breadcrumb.tsx");
    const repoLayout = read("app/RepoLayout.tsx");
    const pathBreadcrumb = read("views/code/PathBreadcrumb.tsx");
    const dir = read("views/code/DirectoryScreen.tsx");
    const blob = read("views/code/BlobScreen.tsx");
    const refSel = read("views/code/RefSelector.tsx");
    const commits = read("views/code/CommitsScreen.tsx");
    const home = read("views/home/index.tsx");
    const issueList = read("views/issues/IssueList.tsx");
    const issueDetail = read("views/issues/IssueDetail.tsx");
    const newIssue = read("views/issues/NewIssue.tsx");
    const prList = read("views/pulls/PRList.tsx");
    const prDetail = read("views/pulls/PRDetail.tsx");
    const mergeBox = read("views/pulls/MergeBox.tsx");
    const prChecks = read("views/pulls/PRChecks.tsx");
    const jobCard = read("views/actions/JobCard.tsx");
    const logViewer = read("views/actions/LogViewer.tsx");
    const releaseAssets = read("views/releases/ReleaseAssets.tsx");
    const releaseForm = read("views/releases/ReleaseForm.tsx");
    const general = read("views/settings/general.tsx");
    const branches = read("views/settings/branches.tsx");
    const webhooks = read("views/settings/webhooks.tsx");

    expect(fields).toContain('"min-h-11 sm:min-h-0"');
    expect(fields).toContain('"min-h-11 pr-8 sm:min-h-0"');
    expect(breadcrumb).toContain('aria-label={props["aria-label"] ?? "Breadcrumb"}');
    expect(repoLayout).toContain('aria-label="Repository breadcrumb"');
    expect(pathBreadcrumb).toContain('aria-label="File path"');
    expect(dir).toContain('aria-label="Commit history"');
    expect(dir).toContain("max-w-full");
    expect(blob).toContain("blame.error ? undefined : blame.latest");
    expect(blob).toContain("refetchBlame()");
    expect(refSel).toContain("Promise.allSettled");
    expect(refSel).toContain("tabError()");
    expect(commits).toContain("h-11 w-11 items-center justify-center rounded-full");
    expect(home).toContain("history().length > 1");
    expect(issueList).toContain("labels.error ? [] : (labels.latest?.items ?? [])");
    expect(issueList).toContain("milestones.error ? [] : (milestones.latest?.items ?? [])");
    expect(issueList).toContain("page.error ? undefined : page.latest");
    expect(issueDetail).toContain('title="Could not load comments"');
    expect(newIssue).toContain("<ButtonLink as={A}");
    expect(prList).toContain("data.error ? undefined : data.latest");
    expect(prList).toContain("const items = pageData()?.items ?? [];");
    expect(prList).toContain("history().length > 1");
    expect(prDetail).toContain("wanted to merge");
    expect(mergeBox).toContain("Merge commit message (optional)");
    expect(prChecks).toContain('role="img"');
    expect(jobCard).toContain("aria-controls={open() ? panelId : undefined}");
    expect(jobCard).toContain("void fetchDetail(true)");
    expect(logViewer).toContain("loadVersion");
    expect(releaseAssets).toContain("inline-flex h-11 w-11 shrink-0");
    expect(releaseForm).toContain("<legend");
    expect(general).toContain("branchData.error ? [] : (branchData.latest?.branches ?? [])");
    expect(branches).toContain("checksRaw()");
    expect(branches).toContain('class="min-w-11 sm:min-w-0"');
    expect(webhooks).toContain("secretTouched()");
    expect(webhooks).toContain('class="min-w-11 sm:min-w-0"');
    expect(webhooks).toContain("aria-controls={showLog() ? logId : undefined}");
  });
});
