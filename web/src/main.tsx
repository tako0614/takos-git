/**
 * takos-git SPA entry — Phase-1 scaffold.
 *
 * Deliberately minimal: it proves the pipeline end to end (Vite build → hashed
 * assets served worker-first under a strict CSP → same-origin `/api/*`). It reads
 * the browser session from `/api/auth/session` and lists repos from
 * `/api/v1/repos`. Depth (the ported code-browser / PR / Actions views) lands in
 * Phase 4. Auth is browser-OIDC cookie only — the SPA never sees Interface OAuth
 * bearers (those stay on the CLI/automation path).
 */

import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import {
  createResource,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type Component,
} from "solid-js";
import "./index.css";

interface SessionResponse {
  authenticated: boolean;
  configured?: boolean;
  user?: { subject: string; name: string | null; email: string | null };
}

interface RepoListResponse {
  repositories: Array<{ name: string; cloneUrl: string }>;
  nextCursor: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return (await response.json()) as T;
}

const RepoListView: Component = () => {
  const [session] = createResource(() =>
    getJson<SessionResponse>("/api/auth/session"),
  );
  const [repos] = createResource(() =>
    getJson<RepoListResponse>("/api/v1/repos").catch(
      () => ({ repositories: [], nextCursor: null }) satisfies RepoListResponse,
    ),
  );

  return (
    <main>
      <header>
        <h1>Takos Git</h1>
        <span class="session">
          <Suspense fallback="Checking sign-in…">
            <Show
              when={session()?.authenticated}
              fallback={
                <Show
                  when={session()?.configured !== false}
                  fallback={<span>Sign-in unavailable</span>}
                >
                  <a href="/api/auth/login?return_to=/">Sign in</a>
                </Show>
              }
            >
              <span>
                {session()?.user?.name ??
                  session()?.user?.email ??
                  "Signed in"}
              </span>
            </Show>
          </Suspense>
        </span>
      </header>

      <ErrorBoundary fallback={<p class="muted">Failed to load repositories.</p>}>
        <Suspense fallback={<p class="muted">Loading repositories…</p>}>
          <Show
            when={(repos()?.repositories.length ?? 0) > 0}
            fallback={<p class="muted">No repositories yet.</p>}
          >
            <ul class="repos">
              <For each={repos()?.repositories}>
                {(repo) => (
                  <li>
                    <div>{repo.name}</div>
                    <code class="muted">{repo.cloneUrl}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Suspense>
      </ErrorBoundary>
    </main>
  );
};

const root = document.getElementById("root");
if (root) {
  render(
    () => (
      <Router>
        <Route path="/" component={RepoListView} />
        <Route path="/:owner/:repo" component={RepoListView} />
      </Router>
    ),
    root,
  );
}
