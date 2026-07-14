import {
  createContext,
  createResource,
  Show,
  useContext,
  type JSX,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { reposApi } from "../api/repos.ts";
import { ApiError } from "../api/client.ts";
import type { RepoDetail } from "../api/types.ts";
import { useSession } from "../store/session.tsx";
import { Icons } from "../lib/Icons.tsx";
import {
  Breadcrumb,
  Button,
  EmptyState,
  Label,
  LoadingBlock,
  UnderlineNav,
  VisibilityBadge,
  type UnderlineNavItem,
} from "../ui/index.ts";
import { PageContainer } from "./AppShell.tsx";

interface RepoContextValue {
  readonly owner: () => string;
  readonly repo: () => string;
  /** Repo metadata (undefined while loading / on error). */
  readonly detail: () => RepoDetail | undefined;
  readonly loading: () => boolean;
  readonly refetch: () => void;
}

const RepoContext = createContext<RepoContextValue>();

/** Access the current repo's owner/name + metadata from any Code/Issues/PR view. */
export function useRepo(): RepoContextValue {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error("useRepo must be used within <RepoLayout>");
  return ctx;
}

function tabs(owner: string, repo: string): UnderlineNavItem[] {
  const base = `/${owner}/${repo}`;
  return [
    { label: "Code", href: base, end: true, icon: <Icons.Code class="h-4 w-4" /> },
    { label: "Issues", href: `${base}/issues`, icon: <Icons.Inbox class="h-4 w-4" /> },
    { label: "Pull requests", href: `${base}/pulls`, icon: <Icons.GitPullRequest class="h-4 w-4" /> },
    { label: "Actions", href: `${base}/actions`, icon: <Icons.Play class="h-4 w-4" /> },
    { label: "Releases", href: `${base}/releases`, icon: <Icons.Tag class="h-4 w-4" /> },
    { label: "Settings", href: `${base}/settings`, icon: <Icons.Settings class="h-4 w-4" /> },
  ];
}

/**
 * The repo chrome: `owner / repo` breadcrumb + visibility badge + star/fork
 * placeholders + the tab UnderlineNav. Loads repo metadata once and shares it
 * with nested route views via `useRepo()`.
 */
export function RepoLayout(props: { children?: JSX.Element }): JSX.Element {
  const params = useParams();
  const session = useSession();
  const owner = () => params.owner ?? "";
  const repo = () => params.repo ?? "";

  const [detail, { refetch }] = createResource(
    () => [owner(), repo()] as const,
    ([o, r]) => reposApi.get(o, r),
  );

  const ctx: RepoContextValue = {
    owner,
    repo,
    detail: () => detail.latest,
    loading: () => detail.loading,
    refetch: () => void refetch(),
  };

  const notFound = () => detail.error instanceof ApiError && detail.error.isNotFound;

  return (
    <RepoContext.Provider value={ctx}>
      <div class="border-b border-border bg-canvas">
        <div class="mx-auto max-w-7xl px-4 pt-4">
          <div class="flex flex-wrap items-center gap-3">
            <Icons.GitBranch class="h-5 w-5 text-muted" />
            <Breadcrumb
              class="text-base"
              items={[
                { label: owner(), href: `/` },
                { label: repo(), href: `/${owner()}/${repo()}` },
              ]}
            />
            <Show when={detail.latest}>
              {(d) => <VisibilityBadge visibility={d().visibility} />}
            </Show>
            <Show when={detail.latest?.forkOf}>
              {(parent) => (
                <Label tone="default">
                  <Icons.GitMerge class="h-3 w-3" /> forked from {parent()}
                </Label>
              )}
            </Show>
            <div class="ml-auto flex items-center gap-2">
              {/* Star/fork are write chrome — shown only when signed in; wired in M2. */}
              <Show when={session.authenticated()}>
                <Button size="sm" variant="default" disabled title="Coming in Phase 4b">
                  <Icons.Star class="h-4 w-4" /> Star
                </Button>
                <Button size="sm" variant="default" disabled title="Coming in Phase 4b">
                  <Icons.GitMerge class="h-4 w-4" /> Fork
                </Button>
              </Show>
            </div>
          </div>
          <Show when={detail.latest?.description}>
            <p class="mt-2 text-sm text-muted">{detail.latest?.description}</p>
          </Show>
          <div class="mt-3">
            <UnderlineNav items={tabs(owner(), repo())} class="border-b-0 px-0" />
          </div>
        </div>
      </div>

      <PageContainer>
        <Show
          when={!notFound()}
          fallback={
            <EmptyState
              icon={<Icons.AlertTriangle class="h-8 w-8" />}
              title="Repository not found"
              description={`No repository ${owner()}/${repo()} is visible to you. It may be private, or you may need to sign in.`}
              action={
                <Show when={!session.authenticated() && session.configured()}>
                  <Button variant="primary" onClick={() => session.signIn()}>Sign in</Button>
                </Show>
              }
            />
          }
        >
          <Show when={!detail.loading || detail.latest} fallback={<LoadingBlock label="Loading repository…" />}>
            {props.children}
          </Show>
        </Show>
      </PageContainer>
    </RepoContext.Provider>
  );
}
