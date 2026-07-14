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
  active: boolean;
  icon: JSX.Element;
  label: string;
  counter?: number | null;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      class={cn(
        "tg-focus -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm",
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

  const number = () => Number(params.number);
  const base = () => `/${repo.owner()}/${repo.repo()}/pulls/${params.number}`;
  const routeIsFiles = () => location.pathname.endsWith(`/pulls/${params.number}/files`);

  const [tab, setTab] = createSignal<Tab>(routeIsFiles() ? "files" : "conversation");
  // Deep-link `/files` → Files tab; leaving that route drops back to conversation.
  createEffect(() => {
    if (routeIsFiles()) setTab("files");
  });
  createEffect(() => {
    if (!routeIsFiles()) setTab((cur) => (cur === "files" ? "conversation" : cur));
  });

  const [data, { refetch }] = createResource(
    () => [repo.owner(), repo.repo(), number()] as const,
    ([owner, name, num]) => pullsApi.get(owner, name, num),
  );

  const goConversation = () => {
    setTab("conversation");
    navigate(base());
  };
  const goCommits = () => {
    setTab("commits");
    navigate(base());
  };
  const goFiles = () => navigate(`${base()}/files`);
  const goChecks = () => {
    setTab("checks");
    navigate(base());
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
          <Mono class="rounded bg-neutral-muted px-1.5 py-0.5">{props.pr.base.ref}</Mono> from{" "}
          <Mono class="rounded bg-neutral-muted px-1.5 py-0.5">{props.pr.head.ref}</Mono>
        </p>
      </div>
    </div>
  );

  return (
    <ErrorBoundary
      fallback={(err) =>
        err instanceof ApiError && err.isNotFound ? (
          <EmptyState
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
          <Banner tone="danger" title="Could not load the pull request">
            {err instanceof ApiError ? err.message : "Unexpected error."}
          </Banner>
        )
      }
    >
      <Suspense fallback={<LoadingBlock label="Loading pull request…" />}>
        <Show when={data()?.pull}>
          {(pr) => (
            <div class="space-y-4">
              <Header pr={pr()} />

              <div role="tablist" aria-label="Pull request sections" class="flex gap-1 overflow-x-auto border-b border-border">
                <TabButton
                  active={tab() === "conversation"}
                  icon={<Icons.MessageSquare class="h-4 w-4" />}
                  label="Conversation"
                  counter={pr().commentsCount}
                  onClick={goConversation}
                />
                <TabButton
                  active={tab() === "commits"}
                  icon={<Icons.GitCommit class="h-4 w-4" />}
                  label="Commits"
                  counter={pr().commitsCount}
                  onClick={goCommits}
                />
                <TabButton
                  active={tab() === "files"}
                  icon={<Icons.File class="h-4 w-4" />}
                  label="Files changed"
                  onClick={goFiles}
                />
                <TabButton
                  active={tab() === "checks"}
                  icon={<Icons.Play class="h-4 w-4" />}
                  label="Checks"
                  onClick={goChecks}
                />
              </div>

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
            </div>
          )}
        </Show>
      </Suspense>
    </ErrorBoundary>
  );
}
