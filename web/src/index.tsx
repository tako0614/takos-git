/**
 * takos-git SPA entry.
 *
 * Mounts `<Router root={AppShell}>` with the full GitHub-parity route table.
 * Feature view bodies are lazy-loaded so the ported (heavy) Phase-4b code never
 * enters the initial bundle — the shell (AppShell + RepoLayout + design system +
 * api client) is the only thing eagerly loaded. Auth is browser-OIDC cookie
 * only; the SPA calls same-origin `/api/*` and never handles Interface bearers.
 */
import { render } from "solid-js/web";
import { lazy } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { initTheme } from "./lib/theme.ts";
import { AppShell } from "./app/AppShell.tsx";
import { RepoLayout } from "./app/RepoLayout.tsx";
import { SettingsLayout } from "./views/settings/layout.tsx";
import { NotFoundView } from "./views/NotFound.tsx";
import "./styles.css";

// Lazy view wrappers (each maps a module export to a route component). Views
// that share a module resolve to the same Vite chunk.
const HomeView = lazy(() => import("./views/home/index.tsx").then((m) => ({ default: m.HomeView })));
const CodeView = lazy(() => import("./views/code/index.tsx").then((m) => ({ default: m.CodeView })));
const CommitView = lazy(() => import("./views/code/index.tsx").then((m) => ({ default: m.CommitView })));
const IssuesView = lazy(() => import("./views/issues/index.tsx").then((m) => ({ default: m.IssuesView })));
const IssueDetailView = lazy(() => import("./views/issues/index.tsx").then((m) => ({ default: m.IssueDetailView })));
const NewIssueView = lazy(() => import("./views/issues/index.tsx").then((m) => ({ default: m.NewIssueView })));
const PullsView = lazy(() => import("./views/pulls/index.tsx").then((m) => ({ default: m.PullsView })));
const PullDetailView = lazy(() => import("./views/pulls/index.tsx").then((m) => ({ default: m.PullDetailView })));
const ActionsView = lazy(() => import("./views/actions/index.tsx").then((m) => ({ default: m.ActionsView })));
const RunDetailView = lazy(() => import("./views/actions/index.tsx").then((m) => ({ default: m.RunDetailView })));
const ReleasesView = lazy(() => import("./views/releases/index.tsx").then((m) => ({ default: m.ReleasesView })));
const GeneralSettingsView = lazy(() => import("./views/settings/index.tsx").then((m) => ({ default: m.GeneralSettingsView })));
const CollaboratorsSettingsView = lazy(() => import("./views/settings/index.tsx").then((m) => ({ default: m.CollaboratorsSettingsView })));
const BranchesSettingsView = lazy(() => import("./views/settings/index.tsx").then((m) => ({ default: m.BranchesSettingsView })));
const WebhooksSettingsView = lazy(() => import("./views/settings/index.tsx").then((m) => ({ default: m.WebhooksSettingsView })));

initTheme();

const root = document.getElementById("root");
if (root) {
  render(
    () => (
      <Router root={AppShell}>
        <Route path="/" component={HomeView} />

        {/* Repo-scoped routes share the RepoLayout chrome (header + tabs). */}
        <Route path="/:owner/:repo" component={RepoLayout}>
          <Route path="/" component={CodeView} />
          <Route path="/tree/:branch/*path" component={CodeView} />
          <Route path="/blob/:branch/*path" component={CodeView} />
          <Route path="/commits/:branch?" component={CodeView} />
          <Route path="/commit/:sha" component={CommitView} />
          <Route path="/compare/*spec" component={CodeView} />

          <Route path="/issues" component={IssuesView} />
          <Route path="/issues/new" component={NewIssueView} />
          <Route path="/issues/:number" component={IssueDetailView} />

          <Route path="/pulls" component={PullsView} />
          <Route path="/pulls/:number" component={PullDetailView} />
          <Route path="/pulls/:number/files" component={PullDetailView} />

          <Route path="/actions" component={ActionsView} />
          <Route path="/actions/runs/:runId" component={RunDetailView} />

          <Route path="/releases" component={ReleasesView} />

          <Route path="/settings" component={SettingsLayout}>
            <Route path="/" component={GeneralSettingsView} />
            <Route path="/collaborators" component={CollaboratorsSettingsView} />
            <Route path="/branches" component={BranchesSettingsView} />
            <Route path="/webhooks" component={WebhooksSettingsView} />
          </Route>
        </Route>

        <Route path="*" component={NotFoundView} />
      </Router>
    ),
    root,
  );
}
