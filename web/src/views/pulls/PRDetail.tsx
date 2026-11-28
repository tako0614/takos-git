/**
 * PR detail orchestrator: header (title, state pill, "wants to merge …" line)
 * and the four tabs — Conversation · Commits · Files changed · Checks. The
 * `/pulls/:number/files` route deep-links the Files tab; the other tabs are
 * in-page state. Owns the pull resource and hands each tab a refetch seam.
 */
import {
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  ErrorBoundary,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import type { PullRequestDto } from "../../api/types.ts";
import { moveTabFocus } from "../../lib/a11y.ts";
import { cn } from "../../lib/cn.ts";
import {
  Banner,
  Button,
  EmptyState,
  Icons,
  LoadingBlock,
  Mono,
  StateLabel,
} from "../../ui/index.ts";
import { prDisplayState, principalName } from "./shared.tsx";
import { PRConversation } from "./PRConversation.tsx";
import { PRCommits } from "./PRCommits.tsx";
import { PRFiles } from "./PRFiles.tsx";
import { PRChecks } from "./PRChecks.tsx";

type Tab = "conversation" | "commits" | "files" | "checks";

function TabButton(props: {
  id: Tab;
  tabId: string;
  panelId: string;
  active: boolean;
  icon: JSX.Element;
  label: string;
  counter?: number | null;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}): JSX.Element {
  return (
    <button
      id={props.tabId}
      type="button"
      role="tab"
      data-tab-id={props.id}
      tabIndex={props.active ? 0 : -1}
      aria-selected={props.active}
      aria-controls={props.active ? props.panelId : undefined}
      onClick={props.onClick}
      onKeyDown={props.onKeyDown}
      class={cn(
        "tg-focus flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm sm:min-h-0",
        props.active
          ? "border-attention-emphasis font-semibold text-fg"
          : "border-transparent text-muted hover:text-fg",
      )}
    >
      {props.icon}
      <span>{props.label}</span>
      <Show when={props.counter != null}>
        <span class="rounded-full bg-neutral-muted px-2 text-xs leading-5 text-fg">{props.counter}</span>
      </Show>
    </button>
  );
}

export function PRDetail(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tabsId = createUniqueId();

  const number = () => Number(params.number);
  const base = () => `/${repo.owner()}/${repo.repo()}/pulls/${params.number}`;
  const routeIsFiles = () => /\/files\/?$/u.test(location.pathname) && location.pathname.includes(`/pulls/${params.number}/`);

  const [tab, setTab] = createSignal<Tab>(routeIsFiles() ? "files" : "conversation");
  let lastPrKey = "";
  createEffect(() => {
    const nextKey = `${repo.owner()}/${repo.repo()}#${params.number}`;
    if (lastPrKey && lastPrKey !== nextKey) {
      setTab(routeIsFiles() ? "files" : "conversation");
    }
    lastPrKey = nextKey;
  });
  // Deep-link `/files` → Files tab; leaving `/files` via browser Back drops back to conversation.
  createEffect(() => {
    if (routeIsFiles()) setTab("files");
    else setTab((cur) => (cur === "files" ? "conversation" : cur));
  });

  const [data, { refetch }] = createResource(
    () => [repo.owner(), repo.repo(), number()] as const,
    ([owner, name, num]) => pullsApi.get(owner, name, num),
  );
  const prData = () =>
    data.state === "ready" || data.state === "refreshing" ? data.latest?.pull : undefined;
  const notFound = () => data.error instanceof ApiError && data.error.isNotFound;
  const loadError = () => (data.error && !notFound() ? data.error : undefined);

  const goConversation = () => {
    setTab("conversation");
    if (routeIsFiles()) navigate(base(), { scroll: false });
  };
  const goCommits = () => {
    setTab("commits");
    if (routeIsFiles()) navigate(base(), { scroll: false });
  };
  const goFiles = () => {
    setTab("files");
    if (!routeIsFiles()) navigate(`${base()}/files`, { scroll: false });
  };
  const goChecks = () => {
    setTab("checks");
    if (routeIsFiles()) navigate(base(), { scroll: false });
  };

  const onTabKeyDown = (e: KeyboardEvent) => {
    const next = moveTabFocus(e);
    if (next === "conversation") goConversation();
    else if (next === "commits") goCommits();
    else if (next === "files") goFiles();
    else if (next === "checks") goChecks();
  };

  const Header = (props: { pr: PullRequestDto }): JSX.Element => (
    <div class="space-y-3">
      <div class="flex flex-wrap items-start gap-3">
        <h1 class="min-w-0 flex-1 text-2xl font-semibold text-fg">
          {props.pr.title} <span class="font-normal text-muted">#{props.pr.number}</span>
        </h1>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <StateLabel
          state={prDisplayState(props.pr)}
          icon={
            props.pr.merged ? (
              <Icons.GitMerge class="h-4 w-4" />
            ) : props.pr.state === "closed" ? (
              <Icons.X class="h-4 w-4" />
            ) : (
              <Icons.GitPullRequest class="h-4 w-4" />
            )
          }
        />
        <p class="text-sm text-muted">
          <span class="font-semibold text-fg">{principalName(props.pr.author)}</span>{" "}
          wants to merge {props.pr.commitsCount} commit{props.pr.commitsCount === 1 ? "" : "s"} into{" "}
          <Mono class="rounded bg-neutral-muted px-1.5 py-0.5 text-fg">{props.pr.base.ref}</Mono> from{" "}
          <Mono class="rounded bg-neutral-muted px-1.5 py-0.5 text-fg">{props.pr.head.ref}</Mono>
        </p>
      </div>
    </div>
  );

  return (
    <ErrorBoundary
      fallback={(err, reset) =>
        err instanceof ApiError && err.isNotFound ? (
          <EmptyState
            headingLevel="h1"
            icon={<Icons.GitPullRequest class="h-8 w-8" />}
            title="Pull request not found"
            description={`No pull request #${params.number} exists in this repository.`}
            action={
              <Button variant="default" onClick={() => navigate(`/${repo.owner()}/${repo.repo()}/pulls`)}>
                Back to pull requests
              </Button>
            }
          />
        ) : (
          <div class="space-y-3">
            <h1 class="sr-only">Pull request error</h1>
            <Banner
              tone="danger"
              title="Could not load the pull request"
              action={
                <Button size="sm" onClick={() => { void refetch(); reset(); }}>
                  Retry
                </Button>
              }
            >
              {err instanceof ApiError ? err.message : "Unexpected error."}
            </Banner>
          </div>
        )
      }
    >
      <Show
        when={!notFound()}
        fallback={
          <EmptyState
            headingLevel="h1"
            icon={<Icons.GitPullRequest class="h-8 w-8" />}
            title="Pull request not found"
            description={`No pull request #${params.number} exists in this repository.`}
            action={
              <Button variant="default" onClick={() => navigate(`/${repo.owner()}/${repo.repo()}/pulls`)}>
                Back to pull requests
              </Button>
            }
          />
        }
      >
        <Show
          when={!loadError()}
          fallback={
            <div class="space-y-3">
              <h1 class="sr-only">Pull request error</h1>
              <Banner
                tone="danger"
                title="Could not load the pull request"
                action={
                  <Button size="sm" disabled={data.loading} onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
              >
                {loadError() instanceof ApiError
                  ? (loadError() as ApiError).message
                  : loadError() instanceof Error
                    ? (loadError() as Error).message
                    : "Unexpected error."}
              </Banner>
            </div>
          }
        >
        <Show when={prData()} fallback={<LoadingBlock label="Loading pull request…" />}>
          {(pr) => (
            <div class="space-y-4">
              <Header pr={pr()} />

              <div role="tablist" aria-label="Pull request sections" class="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
                <TabButton
                  id="conversation"
                  tabId={`${tabsId}-tab-conversation`}
                  panelId={`${tabsId}-panel-conversation`}
                  active={tab() === "conversation"}
                  icon={<Icons.MessageSquare class="h-4 w-4" />}
                  label="Conversation"
                  counter={pr().commentsCount}
                  onClick={goConversation}
                  onKeyDown={onTabKeyDown}
                />
                <TabButton
                  id="commits"
                  tabId={`${tabsId}-tab-commits`}
                  panelId={`${tabsId}-panel-commits`}
                  active={tab() === "commits"}
                  icon={<Icons.GitCommit class="h-4 w-4" />}
                  label="Commits"
                  counter={pr().commitsCount}
                  onClick={goCommits}
                  onKeyDown={onTabKeyDown}
                />
                <TabButton
                  id="files"
                  tabId={`${tabsId}-tab-files`}
                  panelId={`${tabsId}-panel-files`}
                  active={tab() === "files"}
                  icon={<Icons.File class="h-4 w-4" />}
                  label="Files changed"
                  onClick={goFiles}
                  onKeyDown={onTabKeyDown}
                />
                <TabButton
                  id="checks"
                  tabId={`${tabsId}-tab-checks`}
                  panelId={`${tabsId}-panel-checks`}
                  active={tab() === "checks"}
                  icon={<Icons.Play class="h-4 w-4" />}
                  label="Checks"
                  onClick={goChecks}
                  onKeyDown={onTabKeyDown}
                />
              </div>

              <div
                role="tabpanel"
                id={`${tabsId}-panel-${tab()}`}
                aria-labelledby={`${tabsId}-tab-${tab()}`}
              >
                <Suspense fallback={<LoadingBlock label="Loading section…" />}>
                  <Show when={tab() === "conversation"}>
                    <PRConversation owner={repo.owner()} repo={repo.repo()} pr={pr()} onChanged={() => refetch()} />
                  </Show>
                  <Show when={tab() === "commits"}>
                    <PRCommits owner={repo.owner()} repo={repo.repo()} number={pr().number} />
                  </Show>
                  <Show when={tab() === "files"}>
                    <PRFiles owner={repo.owner()} repo={repo.repo()} pr={pr()} />
                  </Show>
                  <Show when={tab() === "checks"}>
                    <PRChecks owner={repo.owner()} repo={repo.repo()} sha={pr().head.sha} />
                  </Show>
                </Suspense>
              </div>
            </div>
          )}
        </Show>
        </Show>
      </Show>
    </ErrorBoundary>
  );
}
