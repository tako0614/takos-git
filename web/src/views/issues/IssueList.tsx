/**
 * The issue list screen: an open/closed toggle, label / milestone / assignee
 * dropdown filters, a client-side title search, and a cursor-paginated list of
 * issue rows. Filters ride as query params on `issuesApi.list`; the search box
 * narrows the loaded page (the API has no full-text issue search).
 */
import {
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { issuesApi } from "../../api/issues.ts";
import { collaboratorsApi } from "../../api/admin.ts";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../store/session.tsx";
import {
  Avatar,
  Banner,
  Box,
  Button,
  ButtonLink,
  EmptyState,
  Icons,
  Label,
  LoadingBlock,
  Menu,
  Pagination,
  RelativeTime,
  TextInput,
  type MenuItem,
} from "../../ui/index.ts";
import { IssueStateIcon, LabelChips, principalName } from "./parts.tsx";
import { LabelManager, MilestoneManager } from "./managers.tsx";
import type { IssueDto, PrincipalRef } from "../../api/types.ts";

type StateFilter = "open" | "closed";

export function IssueList(props: { owner: string; repo: string }): JSX.Element {
  const session = useSession();
  const base = () => `/${props.owner}/${props.repo}`;

  const [state, setStateFilter] = createSignal<StateFilter>("open");
  const [labelFilter, setLabelFilter] = createSignal<string | undefined>();
  const [milestoneFilter, setMilestoneFilter] = createSignal<number | undefined>();
  const [assigneeFilter, setAssigneeFilter] = createSignal<string | undefined>();
  const [search, setSearch] = createSignal("");
  const [labelsOpen, setLabelsOpen] = createSignal(false);
  const [milestonesOpen, setMilestonesOpen] = createSignal(false);

  // Cursor history stack ([null] = first page) so Prev walks back real cursors.
  const [history, setHistory] = createSignal<(string | null)[]>([null]);
  const cursor = () => history()[history().length - 1];
  const resetPaging = () => setHistory([null]);

  // Any filter change returns to the first page.
  const pickState = (v: StateFilter) => {
    setStateFilter(v);
    resetPaging();
  };
  const pickLabel = (v: string | undefined) => {
    setLabelFilter(v);
    resetPaging();
  };
  const pickMilestone = (v: number | undefined) => {
    setMilestoneFilter(v);
    resetPaging();
  };
  const pickAssignee = (v: string | undefined) => {
    setAssigneeFilter(v);
    resetPaging();
  };

  const listKey = createMemo(() => ({
    owner: props.owner,
    repo: props.repo,
    state: state(),
    label: labelFilter(),
    milestone: milestoneFilter(),
    assignee: assigneeFilter(),
    cursor: cursor(),
  }));

  const [page] = createResource(listKey, (k) =>
    issuesApi.list(k.owner, k.repo, {
      state: k.state,
      label: k.label,
      milestone: k.milestone,
      assignee: k.assignee,
      cursor: k.cursor,
    }),
  );

  // Repo labels + milestones + collaborators feed the filter dropdowns.
  const repoKey = () => [props.owner, props.repo] as const;
  const [labels, { refetch: refetchLabels }] = createResource(repoKey, ([o, r]) => issuesApi.labels(o, r));
  const [milestones, { refetch: refetchMilestones }] = createResource(repoKey, ([o, r]) => issuesApi.milestones(o, r));
  const [collaborators] = createResource(repoKey, async ([o, r]) => {
    try {
      return await collaboratorsApi.list(o, r);
    } catch {
      // Listing collaborators needs admin; degrade to an empty candidate set.
      return { items: [] as never[], nextCursor: null };
    }
  });

  const visible = createMemo(() => {
    const items = page()?.items ?? [];
    const q = search().trim().toLowerCase();
    return q ? items.filter((i) => i.title.toLowerCase().includes(q)) : items;
  });

  const activeFilters = () =>
    labelFilter() !== undefined ||
    milestoneFilter() !== undefined ||
    assigneeFilter() !== undefined;

  const clearFilters = () => {
    setLabelFilter(undefined);
    setMilestoneFilter(undefined);
    setAssigneeFilter(undefined);
    setSearch("");
    resetPaging();
  };

  const labelItems = (): MenuItem[] => [
    { label: "All labels", onSelect: () => pickLabel(undefined) },
    ...(labels()?.items ?? []).map(
      (l): MenuItem => ({
        label: (
          <span class="flex items-center gap-2">
            <span
              class="inline-block h-3 w-3 rounded-full border border-border"
              style={{ background: `#${l.color.replace(/^#/, "")}` }}
            />
            {l.name}
          </span>
        ),
        onSelect: () => pickLabel(l.name),
      }),
    ),
  ];

  const milestoneItems = (): MenuItem[] => [
    { label: "All milestones", onSelect: () => pickMilestone(undefined) },
    ...(milestones()?.items ?? [])
      .filter((m) => m.state === "open")
      .map(
        (m): MenuItem => ({
          label: m.title,
          onSelect: () => pickMilestone(m.number),
        }),
      ),
  ];

  const assigneeItems = (): MenuItem[] => [
    { label: "Everyone", onSelect: () => pickAssignee(undefined) },
    ...(collaborators()?.items ?? []).map(
      (c): MenuItem => ({
        label: (
          <span class="flex items-center gap-2">
            <Avatar name={principalName(c.principal)} size={18} />
            {principalName(c.principal)}
          </span>
        ),
        onSelect: () => pickAssignee(c.principal.subject),
      }),
    ),
  ];

  const filterTrigger = (label: string, active: boolean) => (
    <span
      class={`tg-focus inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas-subtle ${
        active ? "font-semibold text-fg" : "text-muted"
      }`}
    >
      {label} <Icons.ChevronDown class="h-4 w-4" />
    </span>
  );

  return (
    <div>
      {/* Toolbar: search + New issue */}
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <label class="relative min-w-[240px] flex-1">
          <span class="sr-only">Search issues</span>
          <Icons.Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <TextInput
            class="pl-8"
            placeholder="Search issues by title"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
        <Menu align="left" triggerLabel="Filter by label" trigger={filterTrigger("Label", labelFilter() !== undefined)} items={labelItems()} />
        <Menu align="left" triggerLabel="Filter by milestone" trigger={filterTrigger("Milestone", milestoneFilter() !== undefined)} items={milestoneItems()} />
        <Menu align="left" triggerLabel="Filter by assignee" trigger={filterTrigger("Assignee", assigneeFilter() !== undefined)} items={assigneeItems()} />
        <div class="ml-auto flex items-center gap-2">
          <Button onClick={() => setLabelsOpen(true)}>
            <Icons.Tag class="h-4 w-4" /> Labels
          </Button>
          <Button onClick={() => setMilestonesOpen(true)}>
            <Icons.Tag class="h-4 w-4" /> Milestones
          </Button>
          <Show when={session.authenticated()}>
            <ButtonLink as={A} href={`${base()}/issues/new`} variant="primary">
              <Icons.Plus class="h-4 w-4" /> New issue
            </ButtonLink>
          </Show>
        </div>
      </div>

      <LabelManager
        owner={props.owner}
        repo={props.repo}
        open={labelsOpen()}
        onClose={() => setLabelsOpen(false)}
        onChanged={() => void refetchLabels()}
      />
      <MilestoneManager
        owner={props.owner}
        repo={props.repo}
        open={milestonesOpen()}
        onClose={() => setMilestonesOpen(false)}
        onChanged={() => void refetchMilestones()}
      />

      <Show when={activeFilters()}>
        <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span class="text-muted">Filters:</span>
          <Show when={labelFilter()}>
            {(l) => <Label tone="accent">label: {l()}</Label>}
          </Show>
          <Show when={milestoneFilter() !== undefined}>
            <Label tone="accent">milestone #{milestoneFilter()}</Label>
          </Show>
          <Show when={assigneeFilter()}>
            {(a) => <Label tone="accent">assignee: {a()}</Label>}
          </Show>
          <button type="button" class="tg-focus rounded px-1 text-accent hover:underline" onClick={clearFilters}>
            Clear
          </button>
        </div>
      </Show>

      <ErrorBoundary
        fallback={(err) => (
          <Banner tone="danger" title="Could not load issues">
            {err instanceof ApiError ? err.message : "Unexpected error."}
          </Banner>
        )}
      >
        <Box>
          {/* Open / Closed toggle bar */}
          <div class="flex items-center gap-4 border-b border-border bg-canvas-subtle px-4 py-2.5 text-sm">
            <button
              type="button"
              class={`tg-focus flex items-center gap-1.5 rounded ${
                state() === "open" ? "font-semibold text-fg" : "text-muted hover:text-fg"
              }`}
              onClick={() => pickState("open")}
            >
              <span class="inline-block h-3.5 w-3.5 rounded-full border-2 border-current" /> Open
            </button>
            <button
              type="button"
              class={`tg-focus flex items-center gap-1.5 rounded ${
                state() === "closed" ? "font-semibold text-fg" : "text-muted hover:text-fg"
              }`}
              onClick={() => pickState("closed")}
            >
              <Icons.Check class="h-4 w-4" /> Closed
            </button>
          </div>

          <Suspense fallback={<LoadingBlock label="Loading issues…" />}>
            <Show
              when={visible().length > 0}
              fallback={
                <EmptyState
                  class="border-0"
                  icon={<Icons.Inbox class="h-8 w-8" />}
                  title={search().trim() ? "No matching issues" : `No ${state()} issues`}
                  description={
                    search().trim()
                      ? "No issue on this page matches your search."
                      : state() === "open"
                        ? "There aren't any open issues. Open one to start the conversation."
                        : "No issues have been closed yet."
                  }
                  action={
                    <Show when={session.authenticated() && !search().trim()}>
                      <ButtonLink as={A} href={`${base()}/issues/new`} variant="primary">
                        <Icons.Plus class="h-4 w-4" /> New issue
                      </ButtonLink>
                    </Show>
                  }
                />
              }
            >
              <Index each={visible()}>
                {(issue) => <IssueRow issue={issue()} base={base()} />}
              </Index>
            </Show>
          </Suspense>
        </Box>

        <Pagination
          hasNext={!!page()?.nextCursor}
          hasPrev={history().length > 1}
          loading={page.loading}
          onNext={() => {
            const next = page()?.nextCursor;
            if (next) setHistory((h) => [...h, next]);
          }}
          onPrev={() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))}
        />
      </ErrorBoundary>
    </div>
  );
}

/** A single issue row in the list. */
function IssueRow(props: { issue: IssueDto; base: string }): JSX.Element {
  const i = () => props.issue;
  const assignees = (): readonly PrincipalRef[] => i().assignees.slice(0, 3);
  return (
    <div class="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-canvas-subtle">
      <div class="mt-0.5">
        <IssueStateIcon state={i().state} />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <A
            href={`${props.base}/issues/${i().number}`}
            class="text-[15px] font-semibold text-fg hover:text-accent"
          >
            {i().title}
          </A>
          <LabelChips labels={i().labels} />
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          <span>#{i().number}</span>
          <span>
            {i().state === "open" ? "opened" : "closed"} <RelativeTime epochMs={i().state === "open" ? i().createdAt : (i().closedAt ?? i().updatedAt)} />
          </span>
          <span>by {principalName(i().author)}</span>
          <Show when={i().milestone}>
            {(m) => (
              <span class="inline-flex items-center gap-1">
                · <Icons.Tag class="h-3 w-3" /> {m().title}
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-3 pt-0.5">
        <Show when={assignees().length > 0}>
          <span class="flex -space-x-1.5">
            <Index each={assignees()}>
              {(a) => (
                <Avatar
                  name={principalName(a())}
                  size={20}
                  class="ring-2 ring-canvas"
                />
              )}
            </Index>
          </span>
        </Show>
        <Show when={i().commentCount > 0}>
          <A
            href={`${props.base}/issues/${i().number}`}
            class="flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            <Icons.MessageSquare class="h-3.5 w-3.5" /> {i().commentCount}
          </A>
        </Show>
      </div>
    </div>
  );
}
