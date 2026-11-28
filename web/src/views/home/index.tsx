import {
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import type { RepositoryDto } from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import { PageContainer } from "../../app/AppShell.tsx";
import {
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  LoadingBlock,
  Pagination,
  RelativeTime,
  TextInput,
  VisibilityBadge,
} from "../../ui/index.ts";
import { NewRepository } from "./NewRepository.tsx";
import { filterRepositories } from "./filter-repos.ts";

/** One repository row in the dashboard list. */
function RepoRow(props: { repo: RepositoryDto }): JSX.Element {
  return (
    <div class="flex items-start justify-between gap-4 border-b border-border px-4 py-4 last:border-b-0">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <A
            href={`/${props.repo.owner}/${props.repo.name}`}
            class="tg-focus inline-flex min-h-11 min-w-0 max-w-full items-center truncate rounded text-base font-semibold text-accent hover:underline sm:min-h-0"
          >
            <span class="truncate">{props.repo.owner}/{props.repo.name}</span>
          </A>
          <VisibilityBadge visibility={props.repo.visibility} />
          <Show when={props.repo.forkOf}>
            <span class="text-xs text-muted">forked from {props.repo.forkOf}</span>
          </Show>
        </div>
        <Show when={props.repo.description}>
          <p class="mt-1 line-clamp-2 text-sm text-muted">{props.repo.description}</p>
        </Show>
        <div class="mt-2 flex items-center gap-4 text-xs text-muted">
          <span class="flex items-center gap-1">
            <Icons.GitBranch class="h-3.5 w-3.5" /> {props.repo.defaultBranch}
          </span>
          <span>Updated <RelativeTime epochMs={props.repo.updatedAt} /></span>
        </div>
      </div>
      <A
        href={`/${props.repo.owner}/${props.repo.name}`}
        aria-label={`Open ${props.repo.owner}/${props.repo.name}`}
        class="tg-focus inline-flex min-h-11 shrink-0 items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas-subtle sm:min-h-0"
      >
        Open
      </A>
    </div>
  );
}

/** Home dashboard: repositories visible to the current session. */
export function HomeView(): JSX.Element {
  const session = useSession();
  const [creating, setCreating] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const filterId = createUniqueId();
  let filterInputEl: HTMLInputElement | undefined;
  // Cursor history stack ([null] = first page) so Prev walks back real cursors.
  const [history, setHistory] = createSignal<(string | null)[]>([null]);
  const cursor = () => history()[history().length - 1];
  const resetPaging = () => setHistory([null]);
  // Source must be an object (always truthy): a bare null cursor would make
  // createResource treat the source as "no fetch" and never load the list.
  const [data, { refetch }] = createResource(
    () => ({ cursor: cursor() }),
    async (s) => {
      try {
        return await reposApi.list({ cursor: s.cursor ?? undefined });
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) {
          return { items: [], nextCursor: null };
        }
        throw error;
      }
    },
  );

  const items = () => (data.error ? [] : (data()?.items ?? []));
  const filtered = createMemo(() => filterRepositories(items(), query()));
  const hasFilter = () => query().trim().length > 0;

  return (
    <PageContainer>
      <div class="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h1 class="text-xl font-semibold">Repositories</h1>
        <Show when={session.authenticated()}>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icons.Plus class="h-4 w-4" /> New
          </Button>
        </Show>
      </div>

      <Show when={session.authenticated()}>
        <NewRepository open={creating()} onClose={() => setCreating(false)} onCreated={() => { setQuery(""); resetPaging(); void refetch(); }} />
      </Show>

      <Show when={session.state() && !session.authenticated() && session.configured()}>
        <Banner
          tone="info"
          class="mb-4"
          action={<Button size="sm" variant="primary" onClick={() => session.signIn()}>Sign in</Button>}
        >
          Sign in with Takosumi Accounts to see private repositories and push access.
        </Banner>
      </Show>

      <ErrorBoundary
        fallback={(err, reset) => (
          <Banner
            tone="danger"
            title="Could not load repositories"
            action={
              <Button size="sm" onClick={() => { void refetch(); reset(); }}>
                Retry
              </Button>
            }
          >
            {err instanceof ApiError ? err.message : "Unexpected error."}
          </Banner>
        )}
      >
        <Suspense fallback={<LoadingBlock label="Loading repositories…" />}>
          <Show
            when={items().length > 0}
            fallback={
              <EmptyState
                icon={<Icons.Database class="h-8 w-8" />}
                title="No repositories yet"
                description={
                  session.authenticated()
                    ? "Repositories you can access will appear here. Create one to get started."
                    : "Repositories you can access will appear here. Sign in and use New to create one."
                }
                action={
                  <Show when={session.authenticated()}>
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Icons.Plus class="h-4 w-4" /> New repository
                    </Button>
                  </Show>
                }
              />
            }
          >
            <div class="mb-4 flex flex-wrap items-center gap-3">
              <div class="relative min-w-[200px] flex-1 sm:max-w-md">
                <label for={filterId} class="sr-only">Filter repositories</label>
                <Icons.Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <TextInput
                  ref={filterInputEl}
                  id={filterId}
                  name="repoFilter"
                  class="min-h-11 pl-8 pr-11 sm:min-h-0 sm:pr-8"
                  placeholder="Find a repository…"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.isComposing || e.keyCode === 229) return;
                    if (e.key === "Escape" && query()) {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    aria-label="Clear repository filter"
                    class="tg-focus absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-canvas-subtle hover:text-fg sm:right-1 sm:h-6 sm:w-6"
                    onClick={() => {
                      setQuery("");
                      filterInputEl?.focus();
                    }}
                  >
                    <Icons.X class="h-3.5 w-3.5" />
                  </button>
                </Show>
              </div>
              <Show when={hasFilter()}>
                <span role="status" class="text-xs text-muted">
                  Showing {filtered().length} of {items().length} {items().length === 1 ? "repository" : "repositories"}
                </span>
              </Show>
            </div>

            <Show
              when={filtered().length > 0}
              fallback={
                <EmptyState
                  icon={<Icons.Search class="h-8 w-8" />}
                  title="No matching repositories"
                  description="No repository on this page matches your filter."
                  action={
                    <Button
                      onClick={() => {
                        setQuery("");
                        filterInputEl?.focus();
                      }}
                    >
                      Clear filter
                    </Button>
                  }
                />
              }
            >
              <Box>
                <For each={filtered()}>{(repo) => <RepoRow repo={repo} />}</For>
              </Box>
            </Show>
            <Pagination
              hasNext={!!data()?.nextCursor}
              hasPrev={history().length > 1}
              loading={data.loading}
              onNext={() => {
                const next = data()?.nextCursor;
                if (next) setHistory((h) => [...h, next]);
              }}
              onPrev={() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))}
            />
          </Show>
        </Suspense>
      </ErrorBoundary>
    </PageContainer>
  );
}
