import {
  createResource,
  createSignal,
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
  VisibilityBadge,
} from "../../ui/index.ts";
import { NewRepository } from "./NewRepository.tsx";

/** One repository row in the dashboard list. */
function RepoRow(props: { repo: RepositoryDto }): JSX.Element {
  return (
    <div class="flex items-start justify-between gap-4 border-b border-border px-4 py-4 last:border-b-0">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <A href={`/${props.repo.owner}/${props.repo.name}`} class="min-w-0 truncate text-base font-semibold text-accent hover:underline">
            {props.repo.owner}/{props.repo.name}
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

  return (
    <PageContainer>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Repositories</h1>
        <Show when={session.authenticated()}>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icons.Plus class="h-4 w-4" /> New
          </Button>
        </Show>
      </div>

      <Show when={session.authenticated()}>
        <NewRepository open={creating()} onClose={() => setCreating(false)} onCreated={() => { resetPaging(); void refetch(); }} />
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
            when={(data()?.items.length ?? 0) > 0}
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
            <Box>
              <For each={data()?.items}>{(repo) => <RepoRow repo={repo} />}</For>
            </Box>
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
