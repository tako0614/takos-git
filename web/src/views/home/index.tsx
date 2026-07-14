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

/** One repository row in the dashboard list. */
function RepoRow(props: { repo: RepositoryDto }): JSX.Element {
  return (
    <div class="flex items-start justify-between gap-4 border-b border-border px-4 py-4 last:border-b-0">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <A href={`/${props.repo.owner}/${props.repo.name}`} class="truncate text-base font-semibold text-accent hover:underline">
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
        class="tg-focus shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-canvas-subtle"
      >
        Open
      </A>
    </div>
  );
}

/** Home dashboard: repositories visible to the current session. */
export function HomeView(): JSX.Element {
  const session = useSession();
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [data] = createResource(cursor, (c) => reposApi.list({ cursor: c ?? undefined }));

  return (
    <PageContainer>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Repositories</h1>
        <Show when={session.authenticated()}>
          <Button variant="primary" disabled title="Create repo — Phase 4b (POST /api/v1/repos)">
            <Icons.Plus class="h-4 w-4" /> New
          </Button>
        </Show>
      </div>

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
        fallback={(err) => (
          <Banner tone="danger" title="Could not load repositories">
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
                description="Repositories you can access will appear here. Create one from the CLI (git push) or the API."
              />
            }
          >
            <Box>
              <For each={data()?.items}>{(repo) => <RepoRow repo={repo} />}</For>
            </Box>
            <Pagination
              hasNext={!!data()?.nextCursor}
              hasPrev={!!cursor()}
              onNext={() => setCursor(data()?.nextCursor ?? null)}
              onPrev={() => setCursor(null)}
            />
          </Show>
        </Suspense>
      </ErrorBoundary>
    </PageContainer>
  );
}
