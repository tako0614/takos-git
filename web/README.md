# takos-git web SPA

The GitHub-like browser SPA for takos-git. **Solid + Vite + Tailwind v4**, served
by the worker's `ASSETS` binding under a hard CSP (`script-src 'self'`, no inline
scripts). This is the **Phase-4a shell**: the app shell, design system, typed API
client, and routing skeleton are complete and frozen; the per-feature views are
live-wired placeholders that **Phase-4b agents fill in**.

## Layout

```
web/
  index.html            # <div id=root> + module script; NO CSP meta (worker owns CSP)
  vite.config.ts        # solid() + tailwindcss(); dev proxy → :8787; fs.allow for the contract
  src/
    index.tsx           # entry: <Router root={AppShell}> + full route table (lazy views)
    styles.css          # Tailwind v4 + GitHub-ish tokens (light/dark via data-theme)
    lib/                # Icons.tsx (ported), safeHref, a11y, withTimeout, cn, time, theme
    api/                # typed fetch client (see below)
    ui/                # design system (see below)
    store/              # toast, confirm, session (Solid singletons/context)
    app/                # AppShell, TopBar, Footer, RepoLayout (+ useRepo)
    views/              # one folder per feature — 4b fills these
```

## Design system — `src/ui` (import from `../../ui`)

`Button` · `ButtonLink` · `IconButton` · `Link` · `ExternalLink` · `Box`
(`BoxHeader`/`BoxRow`/`BoxFooter`) · `Card` · `UnderlineNav` · `Tabs` · `Avatar`
· `Label` · `ColorLabel` · `StateLabel` · `VisibilityBadge` · `Spinner` ·
`LoadingBlock` · `EmptyState` · `Banner` · `ToastHost` · `ConfirmDialogHost` ·
`Dialog` · `Menu` · `Pagination` · `RelativeTime` · `Breadcrumb` · `Field` ·
`TextInput` · `Textarea` · `Select` · `Markdown` (safe, no innerHTML) ·
`CodeBlock`/`Mono`/`Sha` · `DiffView`/`FileDiffView` (unified-diff hunk renderer).
Also re-exported: `Icons`, `useToast`, `useConfirmDialog`.

Tokens live in `styles.css` as `--*` CSS vars surfaced as Tailwind colors
(`bg-canvas`, `text-fg`, `text-muted`, `border-border`, `text-accent`,
`bg-*-subtle`, …). The default Tailwind palette (`zinc`, `emerald`, …) is also
available for ported classes. Dark mode: `lib/theme.ts` stamps a concrete
`data-theme` on `<html>`; the `dark:` variant keys off it. **System font stack —
no external fonts.**

## API client — `src/api` (import from `../../api`)

Thin, typed, same-origin, cookie-auth wrappers over `/api/v1` + `/api/auth`.

| Module | Export | Backs |
| --- | --- | --- |
| `client.ts` | `api`, `getPage`, `repoPath`, `downloadUrl`, `ApiError` | low-level verbs + pagination + error envelope |
| `auth.ts` | `fetchSession`, `signInHref`, `signOut` | browser OIDC session |
| `repos.ts` | `reposApi` | repo CRUD + code browser (tree/blob/commits/commit/compare/branches/tags/raw) |
| `issues.ts` | `issuesApi` | issues, comments, labels, milestones |
| `pulls.ts` | `pullsApi` | PRs, diff/files/commits, reviews, merge, conflicts |
| `releases.ts` | `releasesApi` | releases + assets |
| `actions.ts` | `actionsApi` | workflows, runs, jobs, logs, artifacts, secrets |
| `checks.ts` | `checksApi` | check runs + commit statuses |
| `admin.ts` | `collaboratorsApi`, `branchProtectionApi`, `webhooksApi` | settings sub-tabs |

**Type sharing.** Core `/api/v1` types (`Role`, `Visibility`, `RepositoryDto`,
`SCOPES`, pagination, error envelope) are imported **directly** from the worker
contract `src/contract/v1.ts` via `api/contract.ts` (it is dependency-free, so no
worker runtime leaks). Feature DTOs (issues/pulls/releases/actions/checks) are
**mirrored** in `api/types.ts` because their server `features/<x>/dto.ts` files
import server-only modules; keep the mirror in sync by review.

Lists return `{ items, nextCursor }`; use `<Pagination>` + a cursor signal.
Errors throw `ApiError` (`.status`, `.code`, `.isNotFound`, …) — catch with an
`ErrorBoundary` or the `Probe` helper.

## Routing skeleton & the 4b seam per view

`<Router root={AppShell}>`. Repo routes nest under `RepoLayout` (owner/repo
header + visibility badge + tab `UnderlineNav`); nested views read
`useRepo()` → `{ owner(), repo(), detail(), loading(), refetch() }`. Each view
is `lazy()`-loaded.

| Route(s) | Placeholder | api-client | Key ui/components to port |
| --- | --- | --- | --- |
| `/` | `views/home` `HomeView` (real M1 list) | `reposApi.list` | `Box`, `Pagination`, `RelativeTime` |
| `/:owner/:repo`, `/tree/:branch/*path`, `/blob/:branch/*path`, `/commits/:branch?`, `/commit/:sha`, `/compare/*spec` | `views/code` `CodeView`/`CommitView` | `reposApi` | FileTree, FileViewer/CodeViewer, CommitList, BranchesTab, `DiffView` |
| `/:owner/:repo/issues`, `/issues/new`, `/issues/:number` | `views/issues` | `issuesApi` | IssueList/Detail (fresh), `Markdown` |
| `/:owner/:repo/pulls`, `/pulls/:number`, `/pulls/:number/files` | `views/pulls` | `pullsApi` | PRList/PRDetail/PRComments, `DiffView`, ConflictResolver |
| `/:owner/:repo/actions`, `/actions/runs/:runId` | `views/actions` | `actionsApi` | ActionsTab, RunsList, RunDetail, JobCard |
| `/:owner/:repo/releases` | `views/releases` | `releasesApi` | ReleaseList, asset upload |
| `/:owner/:repo/settings[/collaborators\|/branches\|/webhooks]` | `views/settings` (`SettingsLayout` + panels) | `collaboratorsApi`/`branchProtectionApi`/`webhooksApi` | list + editor panels |
| `*` | `views/NotFound` | — | — |

Each placeholder renders a `<Seam>` (documents ownership) plus a live `<Probe>`
API call, so the seam is demonstrably wired. A 4b agent replaces the placeholder
body, keeps the `useRepo()`/api-client seam, and reuses the design system.

**Shell contract given to every view:** `AppShell` provides session context
(`useSession()`), top bar, toast + confirm hosts, and a route-transition bar.
`RepoLayout` provides the repo chrome + `useRepo()`. Views own only their body
inside the `PageContainer` and must stay CSP-safe: **no inline scripts, no inline
event-handler attributes in raw HTML, no external hosts** (fonts/CDN/images) —
everything self-hosted/bundled. Use the `Markdown` component for user text (never
set `innerHTML`).

## Build / dev

- `bun run dev:web` (from repo root) — Vite dev server, proxies `/api` `/git`
  `/mcp` `/healthz` to `http://localhost:8787` (`wrangler dev`). Override with
  `TAKOS_GIT_WORKER_URL`.
- `bun run build:web` — emits hashed assets to `web/dist/` (served by the worker
  `ASSETS` binding, worker-first, SPA fallback).
- `bun run check:web` — `tsc --noEmit` for the web project.
