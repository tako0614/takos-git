/**
 * Pull-request list: open/closed filter, one row per PR (state glyph, title,
 * branch pair, author + age, comment/commit counters, draft + conflict badges)
 * and a "New pull request" dialog wired to `pullsApi.create`.
 */
import {
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";
import type { PullRequestDto } from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import {
  Banner,
  Box,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icons,
  Label,
  LoadingBlock,
  Mono,
  Pagination,
  RelativeTime,
  TextInput,
  Textarea,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import { PrStateIcon, prDisplayState, principalName } from "./shared.tsx";

type StateFilter = "open" | "closed" | "all";

function BranchPair(props: { base: string; head: string }): JSX.Element {
  return (
    <span class="inline-flex items-center gap-1 text-xs text-muted">
      <Mono class="rounded bg-neutral-muted px-1.5 py-0.5">{props.base}</Mono>
      <Icons.ChevronLeft class="h-3 w-3" />
      <Mono class="rounded bg-neutral-muted px-1.5 py-0.5">{props.head}</Mono>
    </span>
  );
}

function PrRow(props: { pr: PullRequestDto; owner: string; repo: string }): JSX.Element {
  const st = () => prDisplayState(props.pr);
  return (
    <div class="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-canvas-subtle">
      <div class="mt-0.5 shrink-0">
        <PrStateIcon state={st()} />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <A
            href={`/${props.owner}/${props.repo}/pulls/${props.pr.number}`}
            class="truncate font-semibold text-fg hover:text-accent hover:underline"
          >
            {props.pr.title}
          </A>
          <Show when={props.pr.draft && !props.pr.merged}>
            <Label tone="default">Draft</Label>
          </Show>
          <Show when={props.pr.state === "open" && props.pr.mergeable === "dirty"}>
            <Label tone="attention">
              <Icons.AlertTriangle class="h-3 w-3" /> Conflicts
            </Label>
          </Show>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            #{props.pr.number}{" "}
            <Show when={st() === "merged"} fallback={
              <Show when={st() === "closed"} fallback={
                <>opened <RelativeTime epochMs={props.pr.createdAt} /></>
              }>
                closed <RelativeTime epochMs={props.pr.closedAt} />
              </Show>
            }>
              merged <RelativeTime epochMs={props.pr.mergedAt} />
            </Show>{" "}
            by {principalName(props.pr.author)}
          </span>
          <BranchPair base={props.pr.base.ref} head={props.pr.head.ref} />
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-3 text-xs text-muted">
        <span class="flex items-center gap-1" title="Commits">
          <Icons.GitCommit class="h-4 w-4" />
          {props.pr.commitsCount}
        </span>
        <Show when={props.pr.commentsCount > 0}>
          <A
            href={`/${props.owner}/${props.repo}/pulls/${props.pr.number}`}
            class="flex items-center gap-1 hover:text-accent"
            title="Comments"
          >
            <Icons.MessageSquare class="h-4 w-4" />
            {props.pr.commentsCount}
          </A>
        </Show>
      </div>
    </div>
  );
}

function NewPullDialog(props: {
  open: boolean;
  owner: string;
  repo: string;
  defaultBase: string;
  onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const scope = { owner: props.owner, repo: props.repo };
  const pullsHref = `/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/pulls`;
  const [title, setTitle] = createSignal("");
  const [base, setBase] = createSignal(props.defaultBase);
  const [head, setHead] = createSignal("");
  const [body, setBody] = createSignal("");
  const [draft, setDraft] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<number | null>(null);
  const submission = createSubmissionRecovery<{
    input: Parameters<typeof pullsApi.create>[2];
    revision: number;
  }>();
  let retired = false, revision = 0, viewEpoch = 0;
  onCleanup(() => { retired = true; });
  const busy = () => submission.state()?.phase === "sending";
  const close = () => { viewEpoch++; props.onClose(); };
  function change<T>(setter: (value: T) => unknown, value: T): void { revision++; setter(value); }

  const canSubmit = () => !retired && title().trim() && base().trim() && head().trim() && !submission.state();

  const submit = async () => {
    if (!canSubmit()) return;
    const attempt = { input: {
      title: title().trim(),
      body: body().trim() || undefined,
      base: base().trim(),
      head: head().trim(),
      draft: draft(),
    }, revision };
    if (!submission.begin(attempt)) return;
    const epoch = viewEpoch;
    setError(null); setCreated(null);
    try {
      const { pull } = await pullsApi.create(scope.owner, scope.repo, attempt.input);
      if (retired || !submission.acknowledge(attempt)) return;
      if (props.open && epoch === viewEpoch && revision === attempt.revision) {
        toast.success(`Opened pull request #${pull.number}`);
        close();
        navigate(`${pullsHref}/${pull.number}`);
      } else {
        setCreated(pull.number);
      }
    } catch (err) {
      if (retired) return;
      submission.fail(attempt, err);
      setError(err instanceof ApiError ? err.message : "We could not confirm whether the pull request was created.");
    }
  };

  async function allowAnotherCreation(): Promise<void> {
    const attempt = submission.unknown();
    if (!attempt || retired) return;
    const epoch = viewEpoch;
    const ok = await confirm({ title: "Allow another PR creation?", message: `Check the pull requests in ${scope.owner}/${scope.repo} for “${attempt.input.title}” first. The earlier request may still complete. Another creation can produce a duplicate; there is no automatic retry. Your form edits remain here.`, confirmText: "Allow another creation" });
    if (ok && !retired && props.open && epoch === viewEpoch && submission.resolve(attempt)) setError(null);
  }

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title="Open a pull request"
      size="lg"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit()}>
            {busy() ? "Creating…" : "Create pull request"}
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <Show when={submission.unknown()}>
          <Banner tone="warning" title="Creation result unknown">
            <p>{error()} Check the original repository before creating another PR; the earlier request may have succeeded.</p>
            <A class="text-accent hover:underline" href={pullsHref} target="_blank" rel="noopener noreferrer">Check original pull requests</A>
            <Button size="sm" class="ml-2" onClick={() => void allowAnotherCreation()}>Allow another creation</Button>
          </Banner>
        </Show>
        <Show when={!submission.unknown() && error()}>
          {(message) => <Banner tone="danger">{message()}</Banner>}
        </Show>
        <Show when={created()}>
          {(number) => <Banner tone="success">Pull request <A class="text-accent hover:underline" href={`${pullsHref}/${number()}`}>#{number()}</A> was created. Your form edits remain here.</Banner>}
        </Show>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Base branch" required for="pull-base">
            <TextInput
              id="pull-base"
              value={base()}
              onInput={(e) => change(setBase, e.currentTarget.value)}
              placeholder="main"
            />
          </Field>
          <Field label="Compare (head) branch" required for="pull-head">
            <TextInput
              id="pull-head"
              value={head()}
              onInput={(e) => change(setHead, e.currentTarget.value)}
              placeholder="feature-branch"
            />
          </Field>
        </div>
        <Field label="Title" required for="pull-title">
          <TextInput id="pull-title" value={title()} onInput={(e) => change(setTitle, e.currentTarget.value)} />
        </Field>
        <Field label="Description" for="pull-body">
          <Textarea id="pull-body" rows={5} value={body()} onInput={(e) => change(setBody, e.currentTarget.value)} />
        </Field>
        <label class="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={draft()}
            onChange={(e) => change(setDraft, e.currentTarget.checked)}
            class="tg-focus h-4 w-4 rounded border-border"
          />
          Create as draft
        </label>
      </div>
    </Dialog>
  );
}

export function PRList(): JSX.Element {
  const repo = useRepo();
  const identity = createMemo(() => ({ owner: repo.owner(), repo: repo.repo() }));
  const session = useSession();
  const [filter, setFilter] = createSignal<StateFilter>("open");
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [showNew, setShowNew] = createSignal(false);

  // Reset paging whenever the filter changes.
  const setFilterReset = (f: StateFilter) => {
    setFilter(f);
    setCursor(null);
  };

  const [data, { refetch }] = createResource(
    () => [repo.owner(), repo.repo(), filter(), cursor()] as const,
    ([owner, name, state, cur]) =>
      pullsApi.list(owner, name, { state, cursor: cur ?? undefined }),
  );

  const filterButton = (f: StateFilter, label: string, icon: JSX.Element) => (
    <button
      type="button"
      onClick={() => setFilterReset(f)}
      aria-pressed={filter() === f}
      class={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors " +
        (filter() === f
          ? "font-semibold text-fg"
          : "text-muted hover:text-fg")
      }
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div>
      <Show when={session.authenticated() && identity()} keyed>
        {(scope) => <NewPullDialog
          open={showNew()}
          owner={scope.owner}
          repo={scope.repo}
          defaultBase={repo.detail()?.defaultBranch ?? "main"}
          onClose={() => {
            setShowNew(false);
            refetch();
          }}
        />}
      </Show>

      <Box>
        <div class="flex items-center justify-between gap-2 border-b border-border bg-canvas-subtle px-4 py-2">
          <div class="flex items-center gap-1">
            {filterButton("open", "Open", <Icons.GitPullRequest class="h-4 w-4 text-success" />)}
            {filterButton("closed", "Closed", <Icons.Check class="h-4 w-4 text-done" />)}
            {filterButton("all", "All", <Icons.MessageSquare class="h-4 w-4" />)}
          </div>
          <Show when={session.authenticated()}>
            <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
              <Icons.Plus class="h-4 w-4" /> New pull request
            </Button>
          </Show>
        </div>

        <ErrorBoundary
          fallback={(err) => (
            <div class="p-4">
              <Banner tone="danger" title="Could not load pull requests">
                {err instanceof ApiError ? err.message : "Unexpected error."}
              </Banner>
            </div>
          )}
        >
          <Suspense fallback={<div class="p-6"><LoadingBlock label="Loading pull requests…" /></div>}>
            <Show
              when={(data()?.items.length ?? 0) > 0}
              fallback={
                <div class="p-6">
                  <EmptyState
                    icon={<Icons.GitPullRequest class="h-8 w-8" />}
                    title={
                      filter() === "open"
                        ? "No open pull requests"
                        : filter() === "closed"
                          ? "No closed pull requests"
                          : "No pull requests yet"
                    }
                    description="Pull requests propose changes from one branch into another. Open one to start a review."
                  />
                </div>
              }
            >
              <For each={data()?.items}>
                {(pr) => <PrRow pr={pr} owner={repo.owner()} repo={repo.repo()} />}
              </For>
            </Show>
          </Suspense>
        </ErrorBoundary>
      </Box>

      <Pagination
        hasNext={!!data()?.nextCursor}
        hasPrev={!!cursor()}
        loading={data.loading}
        onNext={() => setCursor(data()?.nextCursor ?? null)}
        onPrev={() => setCursor(null)}
      />
    </div>
  );
}
