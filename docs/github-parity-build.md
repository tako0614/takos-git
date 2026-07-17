# Takos Git — GitHub-parity build spec

Status: **planning / in progress** (started 2026-07-14). This is the canonical build
spec for expanding `takos-git` from its M1 hosting shell into a GitHub-parity
collaborative Git hosting product with self-hosted CI (Actions). It refines, and where
noted overrides, [`collaborative-hosting.md`](collaborative-hosting.md); when the two
disagree, this document's Decision record wins for the parity build and
`collaborative-hosting.md` is rewritten to match.

## Decision record

1. **Self-hosted Actions runner.** The CI runner is embedded in takos-git's own Worker as
   a Cloudflare Container + Durable Object, dispatched via Queue. It is NOT an external
   runner Capsule and NOT the Takos agent. This intentionally overrides the
   `collaborative-hosting.md` M3 wording ("runner Interface を使う Actions dispatch"); that
   section is rewritten to describe the self-hosted runner.
2. **Takos runtime is retired.** The Takos product's Actions execution layer
   (`TakosRuntimeContainer` / `RUNTIME_HOST` / `src/worker/runtime/queues/workflow-*`,
   today a 503 stub) is **removed**, not depended upon. takos-git's self-hosted runner is
   the sole, complete replacement. No dual path, no shim, no runtime dependency on Takos
   (forward-only migration).
3. **GitHub-parity in UX and feature set, not wire-compat.** We aim for a GitHub-like
   experience and feature coverage. We do NOT target full GitHub REST/GraphQL or GitHub
   Actions wire compatibility; capabilities are exposed as versioned takos-git surfaces.
4. **R2 stays authoritative for Git data.** D1 is a metadata plane only. Git objects and
   refs remain authoritative in R2; every D1 table carrying a SHA/ref tip is a derived,
   rebuildable projection. The receive-pack per-repo refs-doc ETag CAS stays the atomic
   push boundary.
5. **Ownership re-rooted off Takos.** The `accountId -> accounts` (Takos Space/account)
   coupling is removed. Ownership is a Workspace-scoped Principal + Owner namespace +
   per-repo role (owner/maintainer/writer/reader) model. Auth mechanisms stay unmixed:
   Takosumi Accounts OIDC for humans, Interface OAuth for automation.
6. **Docs-driven, no-legacy.** Reusable Takos code is migrated (not re-invented) into
   takos-git, but with no dual implementations or compatibility shims in the new home; the
   legacy code is deleted from Takos once parity lands.

## How to read this

The [Build sequence](#build-sequence-parallelization--risks) section is the execution
plan (phases, what's parallelizable, quality gates). The remaining sections are the frozen
design contract that implementation agents code against: D1 schema, authorization model,
HTTP route map, SPA architecture, the self-hosted runner, and the two port maps (git +
Actions primitives, and collaboration features).

---

## Build sequence, parallelization & risks

This section defines how to execute the takos-git GitHub-parity expansion as a large parallel multi-agent effort without the fan-out corrupting the shared spine. The governing principle: **a small "frozen contract" is built serially and merged first; everything that touches it stays serial; everything coded *against* it fans out.** The current worker is a flat `if`-chain dispatcher (`src/worker.ts:340-441`) over a single R2 binding (`main.tf:302-306`) — that shape does not survive multi-agent editing, so the first job is to replace the two structural bottlenecks (the `worker.ts` route chain and the single-binding `main.tf`) with append-only registration surfaces *before* anyone writes a feature.

### 1. The frozen contract (Phase 1, strictly serial, one lead agent)

Nothing below fans out until this set exists, is committed to the integration branch, and passes all gates. These files become **read-only for feature agents** — changes to them are funnelled through a single integrator (see §2). Freeze the *full* schema and *full* binding set here even though most features land later, so that fan-out never edits shared infra.

**Frozen files (the "freeze set"):**

- **`main.tf` — all backing bindings up front.** Today it provisions only `cloudflare_r2_bucket.objects` + the worker script (`main.tf:302-372`). Add, gated behind the existing `enable_cloudflare_resources` local: a `cloudflare_d1_database`, a `cloudflare_queue` (producer + consumer bindings), a `cloudflare_durable_object_namespace` with a `new_sqlite_classes` migration for the runner-coordinator DO, and the container binding for the self-hosted Actions runner. Wire each as a new entry in the `bindings = concat(...)` block (`main.tf:319-372`) plus matching `Env` fields in `src/worker.ts:32-42`. This is the single largest source of "two agents edited main.tf" conflicts, so it is done once, here, complete.
- **`migrations/0001_baseline.sql` — the entire D1 schema, ported wholesale.** Port `takos/src/worker/infra/db/schema-repos.ts` (467 LOC: repos, collaborators, issues, labels, milestones, pull_requests, reviews, review_comments, releases, forks) and `schema-workflows.ts` (168 LOC: workflows, workflow_runs, jobs, steps) into one baseline SQL migration, **severing the `accountId -> accounts` FK** (the coupling flagged in the brief) and replacing owner identity with a takos-git-local `principal` / `repo_role` model. Decision: **one frozen baseline, not per-feature migrations** — feature agents write query code against existing tables and never add migration files during fan-out, which removes migration-numbering as a conflict class entirely. Invariant enforced in the schema comment header: **D1 holds metadata only; git objects and refs stay authoritative in R2** (`docs/collaborative-hosting.md:51-53`). No `commit_sha`-keyed table may be treated as a source of truth for reachability.
- **`src/db/schema.ts` + `src/db/client.ts` — TS row types and query helpers.** Hand-written types matching the baseline SQL (takos-git is framework-free; do not import Drizzle). This is the DB contract every feature service imports.
- **`src/db/d1-test-adapter.ts` — a `bun:sqlite`→`D1Database` shim.** Critical and easy to overlook: current tests inject a fake `Env` with an in-memory R2 (`src/test-bucket.ts`, `src/git/repo-object-store.ts`) and call `createGitWorker(fetch)` (`src/worker.ts:443-449`). D1 needs the same treatment or no feature is testable. Provide a `bun:sqlite`-backed object implementing the `D1Database`/`D1PreparedStatement` surface, loaded with `0001_baseline.sql`. Without this, Phase 3/5 fan-out cannot run `bun test`.
- **`src/router.ts` — table-driven route registry replacing the `if`-chain.** Convert `worker.ts:340-441` into a registry: features export `RouteModule[]` (method + path-pattern + handler) and register into a central array *by importing their own module*, so adding a feature edits only that feature's file plus one import line. Keep the existing dispatch order semantics (healthz/icon/mcp/forge/git). **This is the enabling move for parallelism** — after this, `worker.ts` itself is frozen.
- **`src/contract/v1.ts` — versioned API DTOs.** The shared request/response types for `/api/v1/*`, consumed by both route handlers and the SPA. Versioned surface per the decision record (no GitHub wire-compat). This is the SPA↔worker contract.
- **`src/auth/acl.ts` — the fail-closed ACL middleware.** Today auth is binary "member of THE workspace" (`src/interface-oauth-auth.ts`, `src/browser-auth.ts`); there is no per-repo role. Build the `Principal` resolver + `repo_role` gate (owner/maintainer/writer/reader) here, as middleware the registry applies. Decision: **default-deny** — a route with no declared required-role is rejected, not allowed, so a feature agent forgetting to annotate a route fails closed. Keep the two auth mechanisms unmixed (browser OIDC session vs Interface OAuth bearer) exactly as today; ACL runs *after* whichever mechanism authenticated.
- **`src/db/two-phase.ts` — the cross-store state-machine helper.** Encodes the R2-refs-then-D1-metadata ordering (`docs/collaborative-hosting.md:52-53`): the per-repo refs-doc ETag CAS (`src/git/refs-store.ts`) stays the atomic boundary; D1 metadata writes are retryable follow-ups keyed to the resulting commit/ref. PR-merge, push-indexing, and Actions-dispatch all build on this. Freezing it here prevents each feature reinventing (and mis-ordering) the split.
- **SPA scaffold + asset serving.** `web/` Vite/Solid scaffold (mirroring the coupled-but-portable `takos/web/src/views/repos/` tree) + a build step that emits a hashed asset manifest, + one asset-serving route in the registry with a strict CSP. Today the UI is an inline HTML string (`worker.ts:81-263`) with an existing tight CSP (`worker.ts:73-74`); the SPA replaces it. Freeze the asset-serving contract (path prefix, manifest shape, CSP header) now; fill components in Phase 4.
- **`package.json` build/test scripts** for the SPA bundle + worker bundle (the OpenTofu path expects `dist/worker.js`, `main.tf:158`).

**Gate for Phase 1 exit:** `bun test` (adapter + router + acl unit tests), `bun run check`/`bunx tsc --noEmit`, and `tofu validate` + `tofu plan` on `main.tf` with the new bindings all green. Only then is the integration branch tagged and fan-out authorized.

### 2. Parallelizable vs. serial, and conflict avoidance

**Safely parallel (fan-out):** any *feature service module coded entirely against the frozen schema + contract*, living in its own directory. Partition by feature so **no two agents touch the same file** — this is the primary conflict-avoidance mechanism, stronger than worktrees alone:

- `src/features/repos/` (metadata, visibility, collaborators, branch rules)
- `src/features/issues/` (issues, labels, milestones, comments — **built fresh**, absent everywhere)
- `src/features/pulls/` (PR/review/merge — port `takos/src/worker/server/routes/pull-requests/*` 2705 LOC + `merge-resolution.ts`)
- `src/features/releases/` (port `release-crud.ts`, `release-assets.ts`) and `src/features/forks/` (port `source/fork.ts`, `routes/repos/forks.ts`)
- `src/features/webhooks/`, `src/features/checks/` (**fresh**)
- `src/features/actions/` + `src/runner/` (Phase 5)
- SPA views under `web/src/views/<feature>/` — one agent per feature view.

Each feature agent works in an **isolated git worktree** off the integration branch (`EnterWorktree`), touches only its own directory + adds exactly one import line to the registry, and rebases before handing back.

**Not parallelizable (serial, integrator-only):** anything editing `worker.ts`, `main.tf`, `migrations/*`, `src/db/schema.ts`, `src/contract/v1.ts`, `src/auth/acl.ts`, `src/router.ts`. The registry design reduces "edit worker.ts" to "add one import"; batch those import lines through a **single integrator agent** who owns merge order, so the one shared mutable line-range (the registry import list) never conflicts. If a feature genuinely needs a schema or contract change mid-fan-out, it is a **contract-change request to the integrator**, not a direct edit — the integrator amends the freeze set, re-runs Phase-1 gates, and re-broadcasts. Treat freeze-set churn as an exceptional event, not a routine one.

### 3. Phase-by-phase plan

**Phase 1 — Foundation (serial, 1 agent).** Deliverables: the entire freeze set above. Gates: `bun test`, `bunx tsc --noEmit`/`bun run check`, `tofu validate` + `tofu plan`. Verify: fake-D1 adapter round-trips the baseline schema; registry dispatches a trivial `/api/v1/ping`; ACL default-deny proven by a test that a role-less route 403s.

**Phase 2 — Git primitives + read browser (mostly serial, 1-2 agents).** Deliverables: port `takos/src/worker/application/services/takos-git/local/` (804 LOC: object/pack/tree-ops/merge/refs/commit-index, `findMergeBase`/`isAncestor`/`countCommitsBetween` via `local/index.ts`) into `src/git/`, on top of the existing R2 stores (`src/git/object-store.ts`, `pack-reader.ts`, `tree-ops.ts`). Add tree-diff (`lcs-diff.ts` + `unified-diff.ts`, 217 LOC), merge-base, 3-way `mergeTrees3Way`, and blame (`git-advanced.ts:617`). Expand the read forge API (`src/forge-api.ts`, currently GET-only) with commit-diff/tree-diff endpoints. Gates: R2-only tests first (per migration order `docs/collaborative-hosting.md:116`), then check. Verify: diff/merge-base against a seeded repo (`src/seed.ts`). *This phase is a prerequisite for Phase 3 pulls* — keep it ahead of the fan-out.

**Phase 3 — Collaboration fan-out (max parallel, 5-7 agents).** Each agent owns one `src/features/<x>/` + tests: repos-metadata/ACL, issues (fresh), pulls (port, drop `ai-review.ts` per brief), releases, forks, webhooks (fresh), checks/status (fresh). All code against frozen schema/contract/two-phase helper. Gate per-agent before merge: `bun test` in the worktree + `bunx tsc --noEmit`. Integrator merges in dependency order (repos-metadata → issues/pulls → releases/forks → webhooks/checks), re-running full `bun test` after each merge. Verify: E2E per surface against fake-D1 + in-memory R2; PR-merge must exercise the two-phase R2-CAS-then-D1 path and prove the refs-doc ETag boundary holds under a simulated concurrent push.

**Phase 4 — SPA (parallel by view, 4-6 agents).** Port `takos/web/src/views/repos/` (RepoDetail, FileTree/FileViewer, CommitList, PRList/PRDetail/PRDiffView/PRComments, ReleaseList, ForkModal, ConflictResolver, ActionsTab) severing the `web/src/store/{toast,i18n,confirm-dialog}` and `web/src/i18n/*/repository` coupling into takos-git-local equivalents. Consume `src/contract/v1.ts`. Gates: SPA build, `tsc`, plus a Lighthouse/`bun run check` pass. Verify: drive real flows in Chrome DevTools MCP against a running worker; confirm asset serving + CSP (see §4).

**Phase 5 — Actions + self-hosted runner (serial spine, then parallel, highest risk).** Port the pure/portable engine (`actions-engine/` 1416 LOC — parser/validator/scheduler/matrix/glob, already dependency-free), services (`application/services/actions/*` + `workflow-runs/*` 2171 LOC), and routes (`workflows.ts` + `actions/*` 1141 LOC). Then build the **self-hosted runner inside takos-git** (per the decision record, overriding the roadmap's "external runner Interface" — `docs/collaborative-hosting.md:95` must be rewritten): a Durable Object coordinator + Cloudflare Container, mirroring Takosumi's proven `container_runner.ts` / `durable/OpenTofuRunnerObject.ts` / `runner/lib/http_server.ts` and its `RunnerProfile` network/resource/secret policy (`takosumi/contract/internal-deploy-control-api.ts:106-181`), with the generic sandbox container from `takos-apps/takos-computer/apps/sandbox/`. Replace the current `RUNTIME_HOST` 503 stub contract (`takos/src/worker/runtime/queues/workflow-steps.ts:35-54`, `containers/runtime/src/runtime-service.ts`) with an in-worker DO→container step dispatch. Gates: engine unit tests (already exist), runner integration test, `tofu validate` on the DO/container bindings. Verify: end-to-end single-job `run:` workflow executes in the container and writes a check-run.

### 4. Top integration risks & mitigations

- **D1 in a per-request worker vs. R2 authority split.** The whole product's correctness rests on git objects/refs living only in R2 while D1 mirrors metadata. Risk: a feature caches a commit SHA or ref in D1 and treats it as truth, silently diverging after a force-push. **Mitigation:** the `two-phase.ts` helper is the *only* sanctioned cross-store writer; D1 rows referencing git state store SHAs as advisory pointers re-validated against R2 on read; a lint/review rule bans direct `env.DB` ref writes outside the helper; the refs-doc ETag CAS (`src/git/refs-store.ts`) remains the sole atomic boundary. Encode this as a Phase-1 test that a stale D1 pointer is detected, not trusted.
- **Runner container cold-start & the largest unknown.** Cloudflare Containers cold-start plus DO coordination is unproven in this repo (today: zero container bindings). **Mitigation:** land the runner as an isolated Phase-5 spine behind a feature flag; scope the MVP to single-step shell `run:` (no `uses:` action resolution); reuse Takosumi's battle-tested DO/http_server pattern verbatim rather than inventing; keep Actions dispatch on the Queue so a cold/failed runner degrades to "queued", not "lost".
- **SPA asset serving & CSP.** The current inline UI ships a deliberately tight CSP (`worker.ts:73-74`, `default-src 'none'`). A hashed-bundle SPA needs `script-src 'self'` (drop `'unsafe-inline'`) and correct MIME/immutable-cache headers from the single worker (no asset bucket binding exists). **Mitigation:** freeze the asset-serving route + CSP in Phase 1 with a passing test *before* any component is written; use hashed filenames + `Cache-Control: immutable`; forbid inline scripts so the CSP can tighten rather than loosen.
- **ACL fail-open regressions during fan-out.** Seven agents adding routes is the classic path to an unauthenticated endpoint. **Mitigation:** default-deny registry (§1) — an un-annotated route 403s; a Phase-1 meta-test enumerates every registered route and asserts each declares a required role and an auth mechanism; keep browser-session and Interface-OAuth paths unmixed (a route declares exactly one). This makes "forgot the auth check" a failing test, not a shipped hole.

### 5. Effort estimate & honest first-pass scope

Order-of-magnitude net-new/ported LOC (porting reduces authoring but severing `accountId`/`requireSpaceAccess`/`resolveOwnerUsername`/RPC-type coupling adds back):

| Phase | Rough LOC | Notes |
|---|---|---|
| 1 Foundation | 1,500–2,500 | schema 635 ported + db/adapter/router/acl/two-phase/scaffold new |
| 2 Git primitives + read | 1,200–1,800 | port 804 + diff 217 + blame/merge-base |
| 3 Collaboration fan-out | 6,000–8,000 | PR 2705 + issues/webhooks/checks fresh + releases/forks |
| 4 SPA | 5,000–8,000 | ~30 TSX components, decoupled from Takos shell |
| 5 Actions + runner | 6,000–9,000 | engine/services/routes ~4,700 ported + runner DO/container new |
| **Total** | **~20k–28k** | |

**Realistically NOT achievable in a first pass** (defer to versioned follow-ups, honoring "no GitHub wire-compat"): full Actions `uses:` marketplace-action resolution (MVP = `checkout` + `run:` only); Git LFS, shallow/partial clone, protocol v2 compatibility (`docs/collaborative-hosting.md:98`, M3); async code-index/search; merge queue, rulesets, repository templates, org/team administration and audit log (M4); GitHub-compatible webhook signatures and REST/GraphQL/Actions wire-compat (explicitly a non-goal per the decision record); deploy-key/ServiceAccount automation (M4, gated on the workload-token contract); container autoscaling and multi-tenant runner isolation hardening. First pass should target credible **M1 + M2** parity (hosting shell, code browser, issues, PR/review/merge, releases, forks, real ACL/branch protection) with an **M3 Actions MVP** (single-container, single-step `run:` jobs writing check-runs) behind a flag — and leave M3-large-repo/M4-mature-forge as declared, versioned surfaces rather than half-built spine.

---

## D1 metadata schema

### Scope and store boundary

D1 is takos-git's **relational metadata plane** and nothing else. The authoritative store for Git objects and refs stays R2, exactly as today: object storage is repository-scoped under `git/v3/repos/<repo>/objects/...` and refs live in the per-repo document `git/v2/refs/<repo>.json` read/written with ETag CAS (`src/git/refs-store.ts:27`, `:60-128`). That refs-doc ETag `onlyIf` write (`refs-store.ts:120-127`) remains the single atomic boundary for receive-pack. D1 never becomes a second source of truth for a Git object, tree, blob, or ref tip.

**Hard invariant.** Every table below that carries a commit SHA, tree SHA, or ref tip (`ref_index`, `commit_index`, `pr_commits`, `check_runs`, `commit_statuses`, `releases.target_sha`, `git_tags`) is a **derived, rebuildable projection** of R2. On any disagreement, R2 wins and the row is recomputed by re-walking objects. Consequently the takos worker's `blobs`, `chunks`, `files`, and `snapshots` tables (`schema-repos.ts:24`, `:73`, `:131`, `:424`) are **dropped entirely** — they duplicated object/blob bytes and code-index state that R2 + on-demand parse already own. The only git-shaped tables we keep are thin *indexes over R2* so that listing branches/commits/tags never re-lists R2 or re-parses packs per request.

The pervasive `accountId -> accounts(id)` FK in the takos schema (`schema-repos.ts:27-29`, `:376-378`, and on every table) is removed. Ownership is re-rooted on a **Workspace-scoped Principal + owner namespace + per-repo role** model. `actorAccountId` / `authorAccountId` / `reviewerId` become `principal_id` referencing `principals`.

### Conventions

- **Dialect:** SQLite / Cloudflare D1. Delivered as raw SQL migrations (see *Migration delivery* below); a Drizzle mirror in `src/db/schema/*.ts` is optional and, if kept, must match the applied SQL name-for-name (the same drift discipline noted in `schema-repos.ts:12-21`).
- **IDs:** `TEXT` primary keys holding ULIDs (lexicographically sortable, generatable in-worker). Repository-visible sequence numbers (issue/PR `number`, `run_number`) are separate monotonic `INTEGER`s allocated per repo (see `repo_counters`).
- **Timestamps:** `INTEGER` Unix epoch **milliseconds** (not the takos ISO `TEXT`), for cheap range scans and `ORDER BY`. `created_at`/`updated_at` on every mutable row.
- **Booleans:** `INTEGER` 0/1.
- **JSON blobs:** `TEXT` holding JSON for open-ended structured fields (protection rule bodies, webhook event arrays, matrix state, step exec contract).
- **FK actions:** child rows `ON DELETE CASCADE` from their repo/owner/parent; principal references are `ON DELETE SET NULL` so deleting a person never destroys history (authorship degrades to a tombstoned `principal_id`).

---

### 1. Identity and namespace

Replaces the deleted `accounts` FK. A **Principal** is a Takosumi Accounts subject (the OIDC `sub`, ≤512 chars, validated in `src/browser-auth.ts:368-372`) OR an Interface OAuth subject (`taksrv_` bearer `sub`, `src/interface-oauth-auth.ts:188`). An **Owner** is the namespace segment in `<owner>/<name>` — either a user owner backed by one principal, or an org owning many principals via membership.

```sql
-- A workspace-scoped actor. subject = OIDC sub or Interface OAuth sub.
CREATE TABLE principals (
  id             TEXT PRIMARY KEY,           -- ULID, internal stable id
  subject        TEXT NOT NULL,              -- OIDC sub (authoritative identity)
  kind           TEXT NOT NULL DEFAULT 'user', -- 'user' | 'service_account'
  display_name   TEXT,                       -- cached from userinfo, non-authoritative
  email          TEXT,                       -- cached, nullable
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_principals_subject ON principals(subject);

-- Namespace segment. Every repo lives under exactly one owner.
CREATE TABLE owners (
  id             TEXT PRIMARY KEY,
  login          TEXT NOT NULL,              -- URL segment, case-insensitive-unique
  type           TEXT NOT NULL,              -- 'user' | 'org'
  -- for type='user': the single backing principal; null for orgs
  principal_id   TEXT REFERENCES principals(id) ON DELETE SET NULL,
  display_name   TEXT,
  description     TEXT,
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_owners_login ON owners(login COLLATE NOCASE);
CREATE INDEX idx_owners_principal ON owners(principal_id);

-- Org membership (only meaningful for type='org' owners).
CREATE TABLE org_memberships (
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (owner_id, principal_id)
);
CREATE INDEX idx_org_memberships_principal ON org_memberships(principal_id);
```

The single-`APP_WORKSPACE_ID` membership check (`browser-auth.ts:412-413`) stays the coarse gate: no principal exists in D1 unless it is a member of the install workspace. The tables above only *refine* an already-authorized principal into per-repo roles, exactly as `docs/collaborative-hosting.md:68-71` mandates. We do **not** mint a Takosumi Interface per repo.

### 2. Repositories

Rebased from `schema-repos.ts:372-421` with `accountId -> owner_id`, dropping the marketplace-specific `stars/forks/featured/installCount/primaryLanguage/license/gitEnabled` columns that belonged to the Takos catalog, keeping GitHub-parity metadata.

```sql
CREATE TABLE repositories (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- The R2 path segment `<owner_login>/<name>` is derived; store it denormalized
  -- so refs-store / object-store lookups need no join.
  storage_key    TEXT NOT NULL,             -- e.g. "acme/web" -> git/v2/refs/acme/web.json
  description    TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private', -- 'public' | 'private'
  default_branch TEXT NOT NULL DEFAULT 'main',
  fork_of_id     TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  is_template    INTEGER NOT NULL DEFAULT 0,
  pushed_at      INTEGER,                   -- last successful receive-pack
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_repositories_owner_name ON repositories(owner_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX uq_repositories_storage_key ON repositories(storage_key);
CREATE INDEX idx_repositories_visibility_updated ON repositories(visibility, updated_at);
CREATE INDEX idx_repositories_fork_of ON repositories(fork_of_id);

-- Per-repo monotonic sequence allocator. Issues and PRs SHARE one number
-- space (GitHub parity); run_number is per (repo, workflow_path).
CREATE TABLE repo_counters (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,             -- 'issue' (shared issue+PR) | 'workflow:<path>'
  next_value     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, scope)
);
```

`fork_of_id` supersedes the standalone `repo_forks` join table (`schema-repos.ts:272`) for the common single-parent case; the richer fork ledger is kept below only for network-graph queries.

### 3. Collaborators, teams, branch protection (real ACL)

Replaces the `isProtected` boolean stub (`schema-repos.ts:57`) and the absent collaborator/team model. Effective repo access = max of: owner (via `owners.principal_id` / `org_memberships.role='admin'`), direct collaborator role, and team role.

```sql
-- Direct per-repo role grant. role ∈ owner|maintainer|writer|reader.
CREATE TABLE repo_collaborators (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,             -- 'owner'|'maintainer'|'writer'|'reader'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (repo_id, principal_id)
);
CREATE INDEX idx_repo_collaborators_principal ON repo_collaborators(principal_id);

CREATE TABLE teams (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, -- must be type='org'
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_teams_owner_slug ON teams(owner_id, slug COLLATE NOCASE);

CREATE TABLE team_members (
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member', -- 'maintainer'|'member'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, principal_id)
);
CREATE INDEX idx_team_members_principal ON team_members(principal_id);

CREATE TABLE team_repo_access (
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,             -- maps to repo role vocabulary
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id)
);
CREATE INDEX idx_team_repo_access_repo ON team_repo_access(repo_id);

-- Branch protection. pattern is a fnmatch branch glob (e.g. "main", "release/*").
CREATE TABLE branch_protection_rules (
  id                      TEXT PRIMARY KEY,
  repo_id                 TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pattern                 TEXT NOT NULL,
  required_reviews        INTEGER NOT NULL DEFAULT 0,
  dismiss_stale_reviews   INTEGER NOT NULL DEFAULT 0,
  require_code_owner      INTEGER NOT NULL DEFAULT 0,
  required_status_checks  TEXT,             -- JSON array of check names/contexts
  strict_status_checks    INTEGER NOT NULL DEFAULT 0, -- require branch up-to-date
  enforce_admins          INTEGER NOT NULL DEFAULT 0,
  restrict_push           INTEGER NOT NULL DEFAULT 0, -- if 1, only push_allowlist may push
  push_allowlist          TEXT,             -- JSON array of principal_id / team_id
  allow_force_push        INTEGER NOT NULL DEFAULT 0,
  allow_deletions         INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_branch_protection_repo_pattern ON branch_protection_rules(repo_id, pattern);
```

Push enforcement reads these rules during receive-pack, *before* the R2 refs-doc CAS write, so a rejected push never advances the authoritative ref (the CAS boundary in `refs-store.ts:120-127` is unchanged).

### 4. Derived Git indexes (R2 projections, not sources of truth)

Keeps only what listing needs, replacing takos `branches`/`commits`/`tags` (`schema-repos.ts:45`, `:97`, `:445`). These are **caches**: a background reconcile after each push (and a full rebuild op) repopulates them from R2. They carry no data absent from R2.

```sql
-- Projection of the R2 refs-doc so branch/tag listing is one indexed scan.
CREATE TABLE ref_index (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,             -- 'refs/heads/main', 'refs/tags/v1'
  kind           TEXT NOT NULL,             -- 'branch' | 'tag'
  target_sha     TEXT NOT NULL,             -- 40-hex, mirror of refs-doc
  is_default     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);
CREATE INDEX idx_ref_index_repo_kind ON ref_index(repo_id, kind);
CREATE INDEX idx_ref_index_target ON ref_index(repo_id, target_sha);

-- Parsed commit headers so history/graph pages don't re-inflate packs.
CREATE TABLE commit_index (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha            TEXT NOT NULL,
  tree_sha       TEXT NOT NULL,
  parent_shas    TEXT,                      -- space-joined 40-hex parents
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,
  author_at      INTEGER NOT NULL,          -- epoch ms
  committer_name TEXT NOT NULL,
  committer_email TEXT NOT NULL,
  commit_at      INTEGER NOT NULL,
  summary        TEXT NOT NULL,             -- first line, truncated
  message        TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha)
);
CREATE INDEX idx_commit_index_repo_date ON commit_index(repo_id, commit_at);
CREATE INDEX idx_commit_index_tree ON commit_index(tree_sha);

-- Annotated-tag object metadata (lightweight tags need no row; ref_index covers them).
CREATE TABLE git_tags (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  tag_sha        TEXT NOT NULL,             -- the tag object SHA
  target_sha     TEXT NOT NULL,             -- commit it points at
  tagger_name    TEXT,
  tagger_email   TEXT,
  tagged_at      INTEGER,
  message        TEXT,
  PRIMARY KEY (repo_id, name)
);
```

### 5. Issues, comments, labels, milestones (build fresh — absent today)

Issues and PRs share the `issue` counter (§2). Labels attach to both via polymorphic `issue_labels` where the "issue" number space is unified.

```sql
CREATE TABLE milestones (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,          -- per-repo, own sequence
  title          TEXT NOT NULL,
  description    TEXT,
  state          TEXT NOT NULL DEFAULT 'open', -- 'open'|'closed'
  due_on         INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE UNIQUE INDEX uq_milestones_repo_number ON milestones(repo_id, number);

CREATE TABLE labels (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL DEFAULT '888888', -- 6-hex, no '#'
  description    TEXT,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_labels_repo_name ON labels(repo_id, name COLLATE NOCASE);

CREATE TABLE issues (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,          -- shared issue+PR sequence
  title          TEXT NOT NULL,
  body           TEXT,
  state          TEXT NOT NULL DEFAULT 'open', -- 'open'|'closed'
  state_reason   TEXT,                      -- 'completed'|'not_planned'|null
  author_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  milestone_id   TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  -- 0 for a plain issue; when this row IS a PR, pull_requests has a matching row.
  is_pull_request INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE UNIQUE INDEX uq_issues_repo_number ON issues(repo_id, number);
CREATE INDEX idx_issues_repo_state ON issues(repo_id, state, updated_at);
CREATE INDEX idx_issues_author ON issues(author_id);
CREATE INDEX idx_issues_milestone ON issues(milestone_id);

CREATE TABLE issue_assignees (
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, principal_id)
);

CREATE TABLE issue_labels (
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id       TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX idx_issue_labels_label ON issue_labels(label_id);

-- Conversation comments on issues AND pull requests (not inline code comments).
CREATE TABLE issue_comments (
  id             TEXT PRIMARY KEY,
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id, created_at);
```

### 6. Pull requests, reviews, inline comments, PR commits

Rebased from `schema-repos.ts:237-269` (`pull_requests`), `:212-234` (`pr_reviews`), `:187-209` (`pr_comments`). The takos `authorType`/`reviewerType` `'ai'`/`'agent'` defaults are dropped — AI review is out of scope per the decision record. A PR row **extends** an `issues` row (shared number, title, body, state, labels, assignees, milestone, conversation comments all live on the issue), matching GitHub's model and avoiding duplicated columns.

```sql
CREATE TABLE pull_requests (
  id             TEXT PRIMARY KEY,
  issue_id       TEXT NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- head may live in a fork; store repo + ref + resolved tip
  head_repo_id   TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  head_ref       TEXT NOT NULL,            -- branch short name
  head_sha       TEXT NOT NULL,            -- projection of R2 tip at last sync
  base_repo_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  base_ref       TEXT NOT NULL,
  base_sha       TEXT NOT NULL,
  merge_base_sha TEXT,                     -- computed via findMergeBase, cached
  -- mergeability projection; recomputed on head/base movement
  mergeable      TEXT NOT NULL DEFAULT 'unknown', -- 'clean'|'dirty'|'unknown'
  draft          INTEGER NOT NULL DEFAULT 0,
  merged         INTEGER NOT NULL DEFAULT 0,
  merged_at      INTEGER,
  merged_by_id   TEXT REFERENCES principals(id) ON DELETE SET NULL,
  merge_commit_sha TEXT,
  merge_method   TEXT,                     -- 'merge'|'squash'|'rebase'
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_pull_requests_repo ON pull_requests(repo_id);
CREATE INDEX idx_pull_requests_head ON pull_requests(head_repo_id, head_ref);

-- Ordered commits attributed to a PR (projection of the head..base walk).
CREATE TABLE pr_commits (
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  sha            TEXT NOT NULL,
  position       INTEGER NOT NULL,         -- order in the PR
  PRIMARY KEY (pr_id, sha)
);
CREATE INDEX idx_pr_commits_pr_pos ON pr_commits(pr_id, position);

-- A submitted review verdict (approve/request-changes/comment).
CREATE TABLE pr_reviews (
  id             TEXT PRIMARY KEY,
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id    TEXT REFERENCES principals(id) ON DELETE SET NULL,
  state          TEXT NOT NULL,            -- 'approved'|'changes_requested'|'commented'|'pending'|'dismissed'
  body           TEXT,
  commit_sha     TEXT,                     -- head sha the review was made against
  submitted_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_pr_reviews_pr ON pr_reviews(pr_id);
CREATE INDEX idx_pr_reviews_reviewer ON pr_reviews(reviewer_id);

-- Inline code comments (file + line), optionally grouped under a review.
CREATE TABLE pr_review_comments (
  id             TEXT PRIMARY KEY,
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  review_id      TEXT REFERENCES pr_reviews(id) ON DELETE SET NULL,
  in_reply_to_id TEXT REFERENCES pr_review_comments(id) ON DELETE SET NULL,
  author_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  file_path      TEXT NOT NULL,
  -- diff anchor: side + line in the unified diff for that file
  side           TEXT NOT NULL DEFAULT 'RIGHT', -- 'LEFT'|'RIGHT'
  line           INTEGER,                  -- null once outdated
  start_line     INTEGER,                  -- multi-line comment start
  commit_sha     TEXT NOT NULL,            -- diff the anchor refers to
  diff_hunk      TEXT,                     -- cached hunk for stable rendering
  body           TEXT NOT NULL,
  outdated       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_pr_review_comments_pr ON pr_review_comments(pr_id, file_path);
CREATE INDEX idx_pr_review_comments_review ON pr_review_comments(review_id);
```

`merge_base_sha` / `head_sha` / `base_sha` / `mergeable` are projections recomputed by the migrated `findMergeBase` / `mergeTrees3Way` code; they are advisory and re-derived from R2 whenever a ref moves.

### 7. Releases, assets, tags

Rebased from `schema-repos.ts:289-343`, dropping `bundleFormat`/`bundleMetaJson`/`install`-marketplace fields and the `authorAccountId` FK. Release assets stay in R2 (bytes), D1 stores the pointer + metadata.

```sql
CREATE TABLE releases (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  tag_name       TEXT NOT NULL,
  target_sha     TEXT,                     -- resolved commit (projection)
  name           TEXT,
  body           TEXT,
  is_draft       INTEGER NOT NULL DEFAULT 0,
  is_prerelease  INTEGER NOT NULL DEFAULT 0,
  author_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  published_at   INTEGER
);
CREATE UNIQUE INDEX uq_releases_repo_tag ON releases(repo_id, tag_name);
CREATE INDEX idx_releases_repo_published ON releases(repo_id, published_at);

CREATE TABLE release_assets (
  id             TEXT PRIMARY KEY,
  release_id     TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  r2_key         TEXT NOT NULL,            -- git/v3/repos/<repo>/releases/<id>/<name>
  content_type   TEXT,
  size_bytes     INTEGER,
  checksum_sha256 TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'uploaded', -- 'uploading'|'uploaded'
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_release_assets_release_name ON release_assets(release_id, name);
```

### 8. Forks (network graph)

`fork_of_id` on `repositories` handles the parent pointer. This table keeps the fork ledger for network/upstream-sync queries, rebased from `schema-repos.ts:272-286` and `repo_remotes` (`:347-368`) collapsed into one, with the account FK removed.

```sql
CREATE TABLE repo_forks (
  id                TEXT PRIMARY KEY,
  fork_repo_id      TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
  upstream_repo_id  TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  -- external mirror source when the upstream is not a local repo
  upstream_url      TEXT,
  last_synced_at    INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_repo_forks_upstream ON repo_forks(upstream_repo_id);
```

### 9. Webhooks and deliveries (build fresh — absent today)

```sql
CREATE TABLE webhooks (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  content_type   TEXT NOT NULL DEFAULT 'application/json',
  secret_enc     TEXT,                     -- encrypted HMAC secret (see §11 note)
  events         TEXT NOT NULL,            -- JSON array: ['push','pull_request',...]
  active         INTEGER NOT NULL DEFAULT 1,
  ssl_verify     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_webhooks_repo ON webhooks(repo_id);

CREATE TABLE webhook_deliveries (
  id             TEXT PRIMARY KEY,
  webhook_id     TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  payload_r2_key TEXT,                     -- large payloads spill to R2
  request_headers TEXT,                    -- JSON
  status         TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'success'|'failed'
  attempt        INTEGER NOT NULL DEFAULT 1,
  response_status INTEGER,
  response_ms    INTEGER,
  error          TEXT,
  claim_token    TEXT,                     -- owning queue/DO message id (cf. index_jobs)
  delivered_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
```

### 10. Actions: workflows, runs, jobs, steps, artifacts, secrets

Rebased directly from `schema-workflows.ts`. `actorAccountId` -> `actor_id -> principals`; the FK-omission notes (`schema-workflows.ts:62-64`) no longer apply because in a single takos-git schema module there is no circular import. The per-step exec contract (`{run,uses,with,env,shell,working-directory,continue-on-error,timeout-minutes}` from `takos/.../runtime/queues/workflow-steps.ts:35-54`) is persisted as JSON on `workflow_steps.exec_contract` so the self-hosted Container/DO runner (owned by another section of this spec) dispatches from D1, not from a rebuild of the parsed workflow.

```sql
CREATE TABLE workflows (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,            -- '.github/workflows/ci.yml'
  name           TEXT,
  content_sha    TEXT NOT NULL,            -- blob SHA in R2; content itself NOT copied
  triggers       TEXT,                     -- parsed 'on' JSON
  state          TEXT NOT NULL DEFAULT 'active', -- 'active'|'disabled'
  parsed_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_workflows_repo_path ON workflows(repo_id, path);

CREATE TABLE workflow_runs (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  workflow_id    TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  workflow_path  TEXT NOT NULL,
  event          TEXT NOT NULL,            -- 'push'|'pull_request'|'workflow_dispatch'|...
  ref            TEXT,
  sha            TEXT,
  actor_id       TEXT REFERENCES principals(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'queued', -- queued|in_progress|completed
  conclusion     TEXT,                     -- success|failure|cancelled|skipped|timed_out
  run_number     INTEGER NOT NULL,
  run_attempt    INTEGER NOT NULL DEFAULT 1,
  inputs         TEXT,                     -- workflow_dispatch inputs JSON
  queued_at      INTEGER,
  started_at     INTEGER,
  completed_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_workflow_runs_number
  ON workflow_runs(repo_id, workflow_path, run_number, run_attempt);
CREATE INDEX idx_workflow_runs_repo_created ON workflow_runs(repo_id, created_at);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_workflow ON workflow_runs(workflow_id);

CREATE TABLE workflow_jobs (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  job_key        TEXT,                     -- key in the workflow YAML
  name           TEXT NOT NULL,
  matrix         TEXT,                     -- resolved matrix cell JSON
  needs          TEXT,                     -- JSON array of prerequisite job_keys
  status         TEXT NOT NULL DEFAULT 'queued',
  conclusion     TEXT,
  runner_id      TEXT,                     -- self-hosted runner/DO instance id
  runner_name    TEXT,
  logs_r2_key    TEXT,
  queued_at      INTEGER,
  started_at     INTEGER,
  completed_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_workflow_jobs_run ON workflow_jobs(run_id);
CREATE INDEX idx_workflow_jobs_status ON workflow_jobs(status);

CREATE TABLE workflow_steps (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  name           TEXT NOT NULL,
  exec_contract  TEXT NOT NULL,            -- JSON: {run,uses,with,env,shell,working-directory,continue-on-error,timeout-minutes}
  status         TEXT NOT NULL DEFAULT 'pending',
  conclusion     TEXT,
  exit_code      INTEGER,
  error_message  TEXT,
  logs_r2_key    TEXT,
  started_at     INTEGER,
  completed_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_workflow_steps_job_number ON workflow_steps(job_id, number);

CREATE TABLE workflow_run_artifacts (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  r2_key         TEXT NOT NULL,            -- artifact bytes in R2
  size_bytes     INTEGER,
  content_type   TEXT,
  expires_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_workflow_run_artifacts_run ON workflow_run_artifacts(run_id);
CREATE INDEX idx_workflow_run_artifacts_expires ON workflow_run_artifacts(expires_at);

-- Actions secrets: repo-scoped, encrypted at rest, injected into runner only.
CREATE TABLE workflow_secrets (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  value_enc      TEXT NOT NULL,            -- AES-GCM ciphertext; plaintext NEVER stored/logged
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER
);
CREATE UNIQUE INDEX uq_workflow_secrets_repo_name ON workflow_secrets(repo_id, name);
```

### 11. Check runs and commit statuses (build fresh — absent today)

The GitHub-parity check surface. `check_runs` = rich per-run results (the self-hosted Actions runner posts these); `commit_statuses` = the legacy contexted status API. Both are keyed by SHA and are projections that reference commits authoritatively living in R2.

```sql
CREATE TABLE check_runs (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  head_sha       TEXT NOT NULL,           -- commit under check (R2-authoritative)
  name           TEXT NOT NULL,
  -- optional link back to the internal run that produced this check
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  external_id    TEXT,
  status         TEXT NOT NULL DEFAULT 'queued', -- queued|in_progress|completed
  conclusion     TEXT,                    -- success|failure|neutral|cancelled|timed_out|action_required|skipped
  details_url    TEXT,
  output_title   TEXT,
  output_summary TEXT,
  output_r2_key  TEXT,                    -- large annotations/text spill to R2
  started_at     INTEGER,
  completed_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_check_runs_repo_sha ON check_runs(repo_id, head_sha);
CREATE INDEX idx_check_runs_workflow_run ON check_runs(workflow_run_id);

CREATE TABLE commit_statuses (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha            TEXT NOT NULL,
  context        TEXT NOT NULL,           -- 'ci/build', 'security/scan', ...
  state          TEXT NOT NULL,           -- pending|success|failure|error
  description    TEXT,
  target_url     TEXT,
  creator_id     TEXT REFERENCES principals(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);
-- Branch-protection required-check evaluation reads the LATEST state per context;
-- keep every post for history, index for the "latest per (repo,sha,context)" query.
CREATE INDEX idx_commit_statuses_repo_sha_ctx ON commit_statuses(repo_id, sha, context, created_at);
```

Encryption note: `workflow_secrets.value_enc`, `webhooks.secret_enc`, and any Interface OAuth material are encrypted with an env-provided key and are the only columns that ever hold secret bytes; they are never returned by any read API and never written to logs — mirroring the Interface-credential handling in `src/interface-oauth-auth.ts`.

---

### Complete table list (raw SQL is canonical; Drizzle mirror optional)

Identity/namespace: `principals`, `owners`, `org_memberships` · Repos: `repositories`, `repo_counters` · ACL: `repo_collaborators`, `teams`, `team_members`, `team_repo_access`, `branch_protection_rules` · Git projections: `ref_index`, `commit_index`, `git_tags` · Issues: `milestones`, `labels`, `issues`, `issue_assignees`, `issue_labels`, `issue_comments` · PRs: `pull_requests`, `pr_commits`, `pr_reviews`, `pr_review_comments` · Releases: `releases`, `release_assets` · Forks: `repo_forks` · Webhooks: `webhooks`, `webhook_deliveries` · Actions: `workflows`, `workflow_runs`, `workflow_jobs`, `workflow_steps`, `workflow_run_artifacts`, `workflow_secrets` · Checks: `check_runs`, `commit_statuses`.

**Dropped from the takos source schema** (do not port): `blobs`, `chunks`, `files`, `snapshots`, `index_jobs`-as-code-index, and the `branches`/`commits`/`tags` tables in their authoritative form — the first four were object/code-index duplication that R2 owns; the last three survive only as the explicitly-derived `ref_index` / `commit_index` / `git_tags` caches. All `account_id -> accounts(id)` references and the `'ai'`/`'agent'` author defaults are removed.

### Migration delivery

D1 DDL ships as numbered, forward-only SQL under `migrations/` and is embedded into the released Worker. The Worker applies it idempotently on first D1 use through `schema_migrations`; no separate wrangler migration command is required. Each `CREATE TABLE`/`CREATE INDEX` stays idempotent-safe, and an applied migration is never rewritten.

`main.tf` provisions the `cloudflare_d1_database` and binds it as `DB`, so the self-hoster's single `tofu apply` provisions R2 **and** D1. The released Worker embeds the forward-only migrations and self-applies them through its `schema_migrations` ledger on first D1 use; there is no post-apply wrangler migration step. R2 remains the authoritative Git store; D1 is the metadata plane and is fully rebuildable from R2 for every git-derived table.

---

## Identity, namespace & authorization

This section specifies how `takos-git` moves from the current binary "member of THE Workspace" check to a GitHub-like per-repo authorization model, **without adding a second identity provider**. Takosumi Accounts stays the sole human IdP (browser OIDC) and Interface OAuth stays the sole automation credential authority. Everything below — owners, orgs, principals, roles, grants, branch protection — is **app-local product state that lives in the new D1 binding**, keyed off identifiers Accounts already issues (`sub`, `interface_binding_id`). No git object or ref is duplicated into D1; the per-repo refs-doc ETag CAS in R2 remains the atomic ref boundary.

### Design invariants carried in from today

- The browser session is admitted **only** if the Accounts `sub` is present and the install `APP_WORKSPACE_ID` is in `workspace_memberships` (`src/browser-auth.ts:406-417`, callback gate `:539`). This gate is a **precondition**, never a target of ACL widening. Per-repo ACL can only *narrow* what an admitted principal may do.
- The smart-HTTP path already verifies an exact Interface scope before touching the repo (`src/worker.ts:390-418`): `git-receive-pack → source.git.smart_http.write`, else `source.git.smart_http.read`. Per-repo ACL is layered **after** that scope check, never instead of it.
- `verifyInterfaceOAuthBearer` (`src/interface-oauth-auth.ts:146-201`) proves `scope === expectedPermission` (`:190`), `sub` (`:188`), `workspace_id`/`capsule_id`, and full `interface_binding_id`/revision evidence (`:193-196`) — but currently discards all of it, returning `boolean`. To resolve an automation identity we surface that evidence (below) rather than inventing a new token type.
- Repo keys are already `owner/name` two-segment strings (`src/git/refs-store.ts:38-42`). We keep that R2 layout verbatim; the owner segment gains a first-class D1 identity but the on-disk key does not move, so no object migration is required.

### 1. Namespace: app-local user/org owners inside the single install Workspace

**Decision: the install Workspace is the tenancy root ("the instance"); repos live under app-local `Owner` entities of kind `user` or `org` created *inside* that Workspace. We do NOT map Takosumi teams/groups to orgs.**

Rationale — this is forced by the "no second IdP" constraint:

- Accounts only tells the Capsule two things about a human: the `sub` and the set of `workspace_memberships` (`src/browser-auth.ts:278-300`, `:372-386`). It exposes **no team/group structure** to a Capsule. Mapping Workspace-teams→orgs would require an org-membership authority we do not have and cannot query, and would couple repo ACL to an Accounts group lifecycle Takosumi does not surface. That violates the AGENTS boundary that Accounts owns identity while the Capsule owns product ACL (`docs/collaborative-hosting.md:19-20,68-70`).
- The single Workspace is the correct analogue of a GitHub *enterprise/instance*, not of a single *org*. Modeling orgs as app-local owners lets one installation host many orgs and many personal namespaces, matching GitHub parity, while every human in all of them still authenticates through the one Workspace membership gate.

Owner model (D1):

```
owners(
  id            text pk,
  kind          text not null,          -- "user" | "org"
  slug          text not null unique,   -- first path segment; [a-zA-Z0-9._-]+ (refs-store.ts:38-42)
  principal_id  text null,              -- kind="user": the owning human principal
  created_at, updated_at
)
```

- `user` owners are **JIT-provisioned on first browser login** from the session `sub`; the slug is derived from the Accounts claim but is app-local and **renameable without breaking identity** (identity = `sub`, not slug — mirrors legacy `resolveOwnerUsername`, `takos/.../repo-utils.ts:45-57`, but without the Accounts FK).
- `org` owners are created in-app (M4 admin, `docs/collaborative-hosting.md:100-103`); their membership is app-local (`org_members`), never derived from Accounts.
- `repositories` becomes metadata-only (port of `takos/.../schema-repos.ts:372-421`, **stripping `accountId → accounts` FK**): `id, owner_id → owners.id, name, visibility, default_branch, fork_of_id`. It is the **ACL/identity authority**; the R2 refs-doc stays the **ref-state authority**. Both are keyed by the same `owner/name`; existence *for authz* = D1 row present. Creation writes the D1 row and the initial R2 refs-doc; ref mutation continues to go only through the refs-doc CAS.

### 2. Principal model: one resolver, two channels, never a new IdP

A `Principal` is an app-local row keyed on identifiers Accounts already mints. It is resolved from whichever credential channel authenticated the request; the channel also determines the **scope ceiling** (§5).

```
principals(
  id            text pk,
  kind          text not null,       -- "human" | "automation"
  issuer        text not null,       -- OIDC_ISSUER_URL, pins identity to this Accounts
  subject       text not null,       -- OIDC `sub`
  binding_id    text null,           -- automation only: interface_binding_id
  display_name, email,               -- non-authoritative cache, refreshed from userinfo
  unique(issuer, subject, binding_id)
)
```

- **Human (browser)**: from `readBrowserSession` we already have `session.subject` (`src/browser-auth.ts:369`). Resolve/JIT-create `principals(kind="human", issuer, subject=sub, binding_id=null)`. `display_name`/`email` refreshed from the session cache, never trusted for authz.
- **Automation (Interface OAuth)**: replace the boolean return with an evidence-returning verifier so the same proven token yields a principal — no new credential type, no second IdP:

```ts
// interface-oauth-auth.ts — additive; existing boolean wrapper kept for smart_http scope gate
export type InterfaceCredential =
  | { ok: true; subject: string; scope: string;
      interfaceId: string; interfaceBindingId: string; resolvedRevision: number }
  | { ok: false };

export async function verifyInterfaceOAuthCredential(
  request: Request, token: string, expectedPermission: string,
  options: InterfaceOAuthOptions,
): Promise<InterfaceCredential>;   // returns the evidence at :186-197 instead of discarding it
```

Resolve/JIT-create `principals(kind="automation", issuer, subject, binding_id=interfaceBindingId)`. The `(subject, binding_id)` pair is the automation identity: two InterfaceBindings for the same ServiceAccount are distinct principals, so a per-repo grant can target exactly one binding — this is what lets us satisfy `docs/collaborative-hosting.md:68-70` ("app-local ACL narrows the authorized Principal per repository") **without minting a Takosumi Interface per repo**.
- **Anonymous**: no credential ⇒ a sentinel `Principal { kind:"anonymous", id:"anon" }`, eligible only for read on `public` repos (§3).
- **Capsule standalone secret** (MCP `PUBLISHED_MCP_AUTH_TOKEN`, `src/mcp.ts` `authorize`): deployment-local root trust; resolves to a synthetic `instance-admin` principal. Kept only for direct/self-host, never called an InterfaceBinding credential.

`AuthContext` threads channel + principal + scope ceiling to every enforcement point:

```ts
interface AuthContext {
  principal: Principal;
  channel: "browser" | "interface" | "capsule" | "anonymous";
  scopes: ReadonlySet<string>;   // capability ceiling from the credential (§5)
}
```

### 3. Per-repo roles and visibility

Roles are totally ordered: `reader < writer < maintainer < owner`. Grants are app-local:

```
repo_grants(repo_id, principal_id, role, granted_by, created_at,
            primary key (repo_id, principal_id))
org_members(org_id, principal_id, role)   -- base role for every repo the org owns
```

Visibility (`repositories.visibility`, default `private` as in `schema-repos.ts:381`): `private | internal | public`.

**Effective role** is the max over all sources, and `null` (no access) otherwise:

```ts
async function effectiveRole(db, principal: Principal, repo: RepoRow): Promise<Role | null> {
  // owner-entity ownership
  if (repo.ownerKind === "user" && repo.ownerPrincipalId === principal.id) return "owner";
  // org base role
  const org = repo.ownerKind === "org" ? await orgRole(db, repo.ownerId, principal.id) : null;
  // direct grant
  const grant = await grantRole(db, repo.id, principal.id);
  // visibility floor
  const floor: Role | null =
      repo.visibility === "public"   ? "reader"
    : repo.visibility === "internal" && principal.kind !== "anonymous" ? "reader"  // any workspace member
    : null;                          // private ⇒ no floor
  return maxRole(org, grant, floor); // null if all null
}
```

- **public** → `reader` for everyone incl. `anonymous` (read-only clone/fetch and read API without a session).
- **internal** → `reader` for any authenticated Workspace member (they already passed the `:406-417` membership gate), never for anonymous.
- **private** → access only via explicit grant or org membership. A private repo returns **404, not 403**, to a principal with `null` role (existence non-disclosure, GitHub parity).

### 4. One authorization function, called at every enforcement point

```ts
type RepoAction =
  | "contents.read"  | "contents.write"
  | "issues.write"   | "pulls.write"   | "pulls.merge"
  | "releases.write" | "repo.admin";

type AuthzDecision =
  | { allow: true;  role: Role }
  | { allow: false; status: 401|403|404; reason:
      "unauthenticated" | "not_found" | "forbidden" | "scope_insufficient" | "protected_ref" };

async function authorizeRepo(
  db, ctx: AuthContext, owner: string, name: string,
  action: RepoAction, opts?: { ref?: string },   // ref required for contents.write / pulls.merge
): Promise<AuthzDecision>;
```

Algorithm (fail-closed, in order): (a) load repo row — absent ⇒ `404 not_found`; (b) `role = effectiveRole(...)` — `null` ⇒ private repos `404`, public/internal fall through as `reader`; (c) `requiredRole[action]` check — below required ⇒ `403 forbidden` (private ⇒ `404`); (d) **scope ceiling** check against `ctx.scopes` (§5) — fails ⇒ `403 scope_insufficient`; (e) for `contents.write`/`pulls.merge`, `checkBranchProtection(...)` on `opts.ref` — fails ⇒ `403 protected_ref`.

| Action | requiredRole | Required scope (interface channel) |
| --- | --- | --- |
| `contents.read` | reader | `source.git.smart_http.read` (git) / `source.git.hosting.read` (API) |
| `contents.write` (push) | writer | `source.git.smart_http.write` |
| `pulls.write` (open PR, incl. from fork by a reader) | reader→open / writer→edit others' | `source.git.hosting.write` |
| `issues.write` | writer | `source.git.hosting.write` |
| `pulls.merge` | writer (maintainer if base protected) | `source.git.hosting.write` |
| `releases.write` | writer | `source.git.hosting.write` |
| `repo.admin` (settings, visibility, grants, protection, webhooks) | maintainer/owner | `source.git.hosting.admin` |

Call sites:

- **smart_http** (`src/worker.ts` after the scope verify at `:408-418`, before `repoExists`/dispatch): resolve the interface principal via `verifyInterfaceOAuthCredential`, then `authorizeRepo(ctx, owner, name, service==="git-receive-pack" ? "contents.write" : "contents.read", { ref:"*" })`. Repo-level writer gate here; **per-ref branch protection is enforced inside receive-pack** command parsing, where the `old→new` per-ref updates are known, using the same `checkBranchProtection`. Two-layer: repo writer at the edge, protected-ref at the CAS.
- **/api/v1 hosting read** (`src/forge-api.ts:74-110`): `authorizeRead` today returns a repo-agnostic `ForgeIdentity` (`:43-45`) — it becomes `buildAuthContext` (produces `AuthContext`, admitting `anonymous`), and **each handler calls `authorizeRepo(ctx, owner, name, "contents.read")`** for its specific repo. `/api/v1/repos` list is filtered by `contents.read` per row. This adds public/anonymous read that the current all-or-nothing gate cannot express.
- **Browser write API (M2)**: same `authorizeRepo` with the browser `AuthContext`; browser channel carries the **full human scope ceiling** (all actions, still bounded by role).
- **MCP** (`src/mcp.ts` tools): `git_repo_list` filtered by `contents.read`; `git_repo_info` needs `contents.read`; `git_repo_create` needs owner-namespace permission (self user-owner, or `org` maintainer) checked via an `authorizeOwner(ctx, owner, "repo.create")`; `git_repo_delete` needs `repo.admin`.

### 5. New Interface scopes for hosting WRITE, and how branch protection gates writes

Scopes are the **capability ceiling of the credential**; the per-repo role is the **floor of what the identity may do**; effective permission is the **AND** of both. Keep scopes coarse (GitHub-token-like) and push fine-grained "which repo / how much" entirely into the ACL — this is why we do not mint per-repo Interfaces.

Add exactly three versioned hosting-write scopes beyond `source.git.hosting.read`:

- `source.git.hosting.write` — collaboration mutations: issues, labels, milestones, PR open/edit/comment/review, merge, releases, comments. **Not** repo settings.
- `source.git.hosting.admin` — repo administration: visibility, collaborators/grants, branch protection, webhooks, org admin, delete.
- (`source.git.smart_http.write` already exists and remains the push scope; hosting.write does **not** grant push, keeping code-push and product-write separable for least-privilege bots.)

An automation credential that only holds `source.git.hosting.write` therefore can file issues and open PRs but can never push code or change repo settings, even on a repo where its principal is `owner` — the scope ceiling caps it. Conversely `contents.write` (push) still requires `source.git.smart_http.write`, unchanged from `src/worker.ts:394-395`.

**Branch protection** restricts writes *within* an otherwise-allowed writer:

```
branch_protection(repo_id, pattern, require_pr, required_approvals,
                  required_checks_json, restrict_push_json, allow_force_push,
                  primary key (repo_id, pattern))
```

`checkBranchProtection(db, repo, ref, principal, role)` denies `protected_ref` when: the ref matches a protected `pattern` and (`require_pr` ⇒ direct `contents.write` refused, must go through a PR) or (`restrict_push` list excludes this principal) or (force-update on `!allow_force_push`). For `pulls.merge`, the same rule requires `required_approvals` satisfied and `required_checks` green before allowing merge, and raises the requiredRole to `maintainer`. This replaces the legacy inert `branches.isProtected` boolean (`schema-repos.ts:57`) with a real rule engine.

### 6. Fail-closed properties (does not weaken the existing gates)

- The browser Workspace-membership gate (`src/browser-auth.ts:406-417`, `:539`) is untouched and runs **before** any ACL; ACL can only subtract. No ACL path can admit a session that failed membership.
- The smart_http exact-scope check (`src/worker.ts:408-418`) stays first; the new repo-role check is strictly additional. A push still needs `source.git.smart_http.write` **and** writer **and** protected-ref clearance — three independent AND gates.
- Missing configuration stays `503` (as `src/forge-api.ts:104-106`, `src/worker.ts:406`); a failed principal resolution degrades to `anonymous` (public-read only), **never** to elevated access.
- Private-repo non-members receive `404`, not `403` — no existence disclosure.
- Anonymous is admissible **only** for `contents.read` on `public` repos; every other `(channel, action)` requires a resolved principal and a satisfied scope+role+protection triad. Default is deny.
- Identity is pinned to `(issuer, subject[, binding_id])`, so rotating an Interface token or renaming an owner slug never re-binds grants to a different human or bot; grants survive credential rotation because they target the app-local principal, not the token.

### Roadmap doc reconciliation

`docs/collaborative-hosting.md:63-70` ("write permission after repository ACL exists"; "app-local ACL narrows the authorized Principal per repository; do not mass-produce Interfaces per repo") is satisfied verbatim by this model. The M2 line "collaborators, teams" (`:84`) is realized as `repo_grants` + `org_members` (app-local), and the doc's phrase should be tightened to "app-local collaborators and org members (not Accounts teams)" to preclude a future reader from wiring org membership to an Accounts group source.

---

## HTTP route map & write API

This section defines the full `takos-git` HTTP surface for GitHub-parity collaborative hosting. It evolves the current GET-only `/api/v1` (`src/forge-api.ts:464`) into a complete read+write forge API while preserving three invariants: Git objects and refs remain authoritative in R2 (D1 never duplicates them); every ref mutation — including web edits, merges, and tag creation — flows through the existing per-repo refs-doc ETag CAS as its atomic boundary (`src/git/refs-store.ts`); and the two authentication mechanisms (browser OIDC session vs. Interface OAuth bearer) stay unmixed at the identity layer. Smart HTTP (`/git/*`) and `/mcp` are unchanged.

### 1. URL shape and versioning

All hosting endpoints live under a single versioned prefix and address repositories by the existing flat `owner/name` pair, **not** the legacy opaque `:repoId`:

```
/api/v1/repos/:owner/:repo/<resource...>
```

This extends the scheme already parsed in `parseRepoRoute` (`src/forge-api.ts:125`) rather than adopting Takos's `/repos/:repoId/...` and `/spaces/:spaceId/repos` shapes (`takos/src/worker/server/routes/repos/routes.ts:64`). Every ported handler must be rewritten to resolve `:owner/:repo` → repo record instead of `checkRepoAccess(repoId)` / `requireSpaceAccess(spaceId)`. `:owner` and `:repo` are `decodeURIComponent`'d and validated with `isValidRepoName` exactly as today (`src/forge-api.ts:135`). New capability surfaces that are not repo-scoped (org/team admin, cross-repo search) get sibling top-level collections (`/api/v1/orgs/:org`, `/api/v1/search`). Per the decision record, this is a *versioned capability surface*, not GitHub REST/GraphQL wire-compat; response bodies are takos-git-native.

`:ref` in browse routes accepts a branch name, a tag name, or (for hardened endpoints) a full 40-hex SHA. The M1 rule "branch-name only, no arbitrary SHA" (`docs/collaborative-hosting.md:149`) is **relaxed for read** once D1 tracks reachable commits: a SHA is accepted only if it is reachable from some ref (checked via the ported `isAncestor`/commit-index, `takos/.../takos-git/local/index.ts`), which preserves the original goal of not exposing dangling objects from rejected pushes.

### 2. Identity, scopes, and roles (how web and automation share routes)

Web and automation call the **same routes and the same handlers**. They diverge only in a front identity middleware that produces a single `ForgePrincipal`, extending the current `ForgeIdentity` union (`src/forge-api.ts:43`):

- **Browser** — HttpOnly OIDC session (`readBrowserSession`, `src/browser-auth.ts`). Carries the full scope ceiling; capability is bounded only by the caller's per-repo role. All mutating (non-GET, non-HEAD) browser requests additionally require an anti-CSRF check (`Origin`/`Sec-Fetch-Site` same-origin **and** a `X-Takos-Git-CSRF` header echoing a session-bound token); bearer callers are exempt because they carry no ambient cookie.
- **Automation** — opaque `taksrv_` Interface OAuth bearer, verified via Accounts `/oauth/userinfo` (`verifyInterfaceOAuthBearer`, `src/interface-oauth-auth.ts`). The bearer's granted scopes form a **capability ceiling**.

Effective permission = `min(scope ceiling, per-repo role)`. Two independent axes:

**Interface OAuth scopes** (transport scopes unchanged; three hosting scopes, up from one):

| Scope | Grants |
| --- | --- |
| `source.git.smart_http.read` / `.write` | Git transport only (unchanged; keep unmixed from hosting) |
| `source.git.hosting.read` | GET on all hosting resources (existing, `src/forge-api.ts:29`) |
| `source.git.hosting.write` | **new** — issues/PRs/comments/reviews/releases CRUD, direct content commits, workflow dispatch, re-run/cancel |
| `source.git.hosting.admin` | **new** — repo settings/visibility/delete, collaborators/teams, branch protection, webhooks, Actions secrets, check-run/status publish |
| `mcp.invoke` | MCP tools only (unchanged) |

**Per-repo roles** (replaces today's binary "member of THE workspace"; realizes roadmap `docs/collaborative-hosting.md:68-70`). Legacy Takos roles `owner/admin/editor/viewer` (`checkRepoAccess([...])`) map to:

| Role | Capabilities |
| --- | --- |
| `reader` | read; open issues; comment; open PRs from forks |
| `writer` | reader + push-equivalent content commits, open/label/assign issues & PRs on the repo, submit reviews, upload release assets |
| `maintainer` | writer + merge PRs, manage releases, edit others' issues/PRs, manage labels/milestones, trigger/cancel/re-run workflows, edit non-protected repo settings |
| `owner` / `admin` | maintainer + visibility, collaborators/teams, branch protection, webhooks, secrets, transfer/delete |

Private-repo reads require at least `reader`; public repos allow anonymous GET (mirrors legacy `allowPublicRead: true`, `takos/.../pull-requests/routes.ts:153`). The `authorizeRead` helper (`src/forge-api.ts:74`) generalizes to `authorize(request, env, { scope, role })`.

### 3. Pagination, error envelope, conventions

- **Pagination** — one convention everywhere: `?limit=<1..100, default 30>&cursor=<opaque>`, response `{ <resourceKey>: [...], nextCursor: string | null }`. This matches the existing repos listing (`src/forge-api.ts:494`) and R2 commit walk. D1-backed lists encode their offset/keyset inside the opaque cursor; the offset/limit pairs in ported handlers (`parsePagination`, `takos/.../pull-requests/routes.ts:143`) are converted at the route edge — no `offset` query param is exposed.
- **Error envelope** — standardize on `{ "error": { "code": "snake_case", "message": string, "details"?: object } }`. The current flat `{ error: "code" }` (`src/forge-api.ts:47`) and Takos's `AppError`/`ErrorCodes` bodies both migrate to this shape; `details.fields` carries validation errors. `405` keeps the `Allow` header; `401` keeps `WWW-Authenticate` (`src/forge-api.ts:107`). `413` size-limit codes (`blob_too_large`, `tree_too_large`, etc.) are preserved.
- **Idempotency / concurrency** — resources with optimistic concurrency (repo settings, branch protection, PR state) accept `If-Match` against a returned `ETag`. Ref-writing endpoints surface the refs-doc CAS failure as `409 ref_update_conflict` (retryable), never a silent overwrite.
- **`Idempotency-Key`** honored on POST create endpoints for at-least-once automation callers.

### 4. Route table

Auth column = required Interface-OAuth scope ceiling **/** minimum repo role. "browser" reads carry full ceiling bounded by role. `PORT` = adapt existing Takos handler (rewrite `:repoId`→`:owner/:repo`, sever `accounts`/`Space` FK, drop Takos RPC types); `NEW` = build fresh.

#### 4.1 Repository CRUD, visibility, settings

| Method | Path | Auth (scope / role) | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/repos` | hosting.read / — | List visible repos (cursor) | exists (`forge-api.ts:486`) |
| POST | `/api/v1/repos` | hosting.write / workspace-member | Create repo (`{owner,name,description,visibility,defaultBranch}`) | PORT `repos/routes.ts:64` |
| GET | `/api/v1/repos/:owner/:repo` | hosting.read / reader | Repo metadata + branch/tag counts | exists (`forge-api.ts:213`) + PORT `routes.ts:192` |
| PATCH | `/api/v1/repos/:owner/:repo` | hosting.admin / maintainer | Update description/visibility/default_branch/topics | PORT `routes.ts:251` |
| DELETE | `/api/v1/repos/:owner/:repo` | hosting.admin / owner | Delete repo (R2 prefix + D1 rows) | PORT `routes.ts:324` |
| POST | `/api/v1/repos/:owner/:repo/transfer` | hosting.admin / owner | Transfer ownership | NEW |
| GET/PUT | `/api/v1/repos/:owner/:repo/settings` | hosting.admin / owner | Merge options, feature toggles (issues/actions/wiki) | NEW |

Visibility is a first-class `public|private|internal` column (roadmap M2); `internal` = visible to any workspace member, distinct from per-repo `reader` grants.

#### 4.2 Collaborators, teams (net-new ACL)

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/repos/:owner/:repo/collaborators` | hosting.read / reader | List collaborators + roles | NEW |
| PUT | `/api/v1/repos/:owner/:repo/collaborators/:principal` | hosting.admin / owner | Add/set role (`reader\|writer\|maintainer\|admin`) | NEW |
| DELETE | `/api/v1/repos/:owner/:repo/collaborators/:principal` | hosting.admin / owner | Remove collaborator | NEW |
| GET | `/api/v1/orgs/:org/teams` | hosting.read / org-member | List teams | NEW |
| POST/PATCH/DELETE | `/api/v1/orgs/:org/teams[/:team]` | hosting.admin / org-admin | Team CRUD | NEW |
| PUT/DELETE | `/api/v1/orgs/:org/teams/:team/members/:principal` | hosting.admin / org-admin | Team membership | NEW |
| PUT/DELETE | `/api/v1/repos/:owner/:repo/teams/:team` | hosting.admin / owner | Grant/revoke team role on repo | NEW |

`:principal` is a Takosumi Accounts subject id. ACL rows are app-local D1 (`docs/collaborative-hosting.md:68`); takos-git does not mint one Takosumi Interface per repo.

#### 4.3 Branch protection (net-new; replaces `isProtected` boolean stub)

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/repos/:owner/:repo/branch-protection` | hosting.read / maintainer | List rules | NEW |
| GET/PUT/DELETE | `/api/v1/repos/:owner/:repo/branch-protection/:pattern` | hosting.admin / owner | Rule for glob pattern: required approvals, required checks, required status contexts, linear-history, restrict-pushers, allow-force-push | NEW |

Rules are enforced server-side in the ref-write path (§4.5, §4.8): a protected-branch ref update via merge or direct commit is rejected `409 branch_protected` unless required approvals/checks are satisfied.

#### 4.4 Code browser read (extends existing branches/commits/tree/blob)

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `…/branches` | read / reader | Branch list | exists (`forge-api.ts:235`) |
| GET | `…/branches/:name` | read / reader | Single branch + protection status | NEW |
| GET | `…/tags` | read / reader | Tag list (cursor) | NEW |
| GET | `…/commits?ref=&path=&limit=&cursor=` | read / reader | Commit history (add `path` filter) | exists (`forge-api.ts:246`) + PORT history `git-advanced.ts:464` |
| GET | `…/commits/:sha` | read / reader | Single commit + diff vs first parent | PORT diff engine (`git-files.ts:142`) — NEW route |
| GET | `…/compare/:base...:head` | read / reader | Two-ref diff + ahead/behind (uses `findMergeBase`) | PORT `git-files.ts:142` diff + `countCommitsBetween` |
| GET | `…/tree?ref=&path=` | read / reader | Directory listing | exists (`forge-api.ts:304`) |
| GET | `…/blob?ref=&path=` | read / reader | File content (utf-8/base64, ≤1 MiB) | exists (`forge-api.ts:383`) |
| GET | `…/raw/:ref/:path{.+}` | read / reader | Raw bytes, real content-type, streamed (no 1 MiB JSON cap) | NEW |
| GET | `…/blame/:ref/:path{.+}` | read / reader | Line blame | PORT `git-advanced.ts:617` |
| GET | `…/contents/:ref/:path{.+}` | read / reader | Unified tree-or-blob metadata (GitHub-parity contents) | NEW (wraps tree/blob) |
| GET | `…/search/code?q=&ref=` | read / reader | In-repo code search | PORT text path of `git-advanced.ts:265` (drop semantic/AI embedding index) |

Blob/tree/commit size guards (`MAX_BLOB_BYTES`, `MAX_TREE_BYTES`, `MAX_COMMIT_BYTES`, `src/forge-api.ts:32`) carry over. `/raw` is the streaming escape hatch for large/binary files and bypasses the JSON envelope.

#### 4.5 Contents write / direct commits (net-new API, existing R2 CAS boundary)

Web "edit file" and automation commits must not bypass the refs-doc CAS. These endpoints build undeltified objects and update the ref via the same conditional R2 write used by receive-pack.

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| PUT | `…/contents/:path{.+}` | hosting.write / writer | Create/update file → new commit on branch (`{branch, message, content, sha?}`) | PORT commit builder `git-commits.ts:361` |
| DELETE | `…/contents/:path{.+}` | hosting.write / writer | Delete file → new commit | PORT |
| POST | `…/commits` | hosting.write / writer | Multi-file commit (tree ops) | PORT `local/operations.ts commitFile` |
| POST | `…/branches` | hosting.write / writer | Create branch from ref (CAS create) | NEW |
| DELETE | `…/branches/:name` | hosting.write / writer | Delete branch (blocked if protected) | NEW |
| POST/DELETE | `…/tags[/:name]` | hosting.write / writer | Lightweight/annotated tag | NEW |

All emit `409 ref_update_conflict` on CAS miss and enforce branch protection (§4.3).

#### 4.6 Issues, comments, labels, milestones (net-new)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET/POST | `…/issues` | read·write / reader·writer(open) | List (filter state/label/assignee/milestone, cursor) / open |
| GET/PATCH | `…/issues/:number` | read·write / reader·author\|maintainer | Get / edit title,body,state,assignees,labels,milestone |
| POST | `…/issues/:number/comments` | write / reader | Comment |
| GET | `…/issues/:number/comments` | read / reader | List comments |
| PATCH/DELETE | `…/issues/comments/:id` | write / author\|maintainer | Edit/delete comment |
| GET/POST | `…/labels` | read·admin / reader·maintainer | List / create label |
| PATCH/DELETE | `…/labels/:name` | admin / maintainer | Edit/delete |
| GET/POST | `…/milestones` | read·admin / reader·maintainer | List / create |
| PATCH/DELETE | `…/milestones/:number` | admin / maintainer | Edit/close/delete |

Issues share the comment/label/milestone tables with PRs (a PR is an issue with a branch pair), mirroring the GitHub model; comment shape reuses ported `pull-requests/comments.ts`.

#### 4.7 Pull requests, reviews, inline comments

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| POST | `…/pulls` | write / writer (or fork reader) | Open PR | PORT `pull-requests/routes.ts:41` |
| GET | `…/pulls` | read / reader | List (filter state, cursor) | PORT `routes.ts:127` |
| GET | `…/pulls/:number` | read / reader | Detail + mergeability | PORT `routes.ts:170` |
| PATCH | `…/pulls/:number` | write / author\|maintainer | Edit title/body/base | PORT `routes.ts:241` |
| POST | `…/pulls/:number/close` | write / author\|maintainer | Close | PORT `routes.ts:321` |
| POST | `…/pulls/:number/reopen` | write / author\|maintainer | Reopen | NEW |
| GET | `…/pulls/:number/diff` | read / reader | Diff payload | PORT `routes.ts:207` + `diff.ts` |
| GET | `…/pulls/:number/files` | read / reader | Per-file diff list (cursor) | PORT `diff.ts` |
| GET | `…/pulls/:number/commits` | read / reader | PR commit list | NEW (commit-index range) |
| GET | `…/pulls/:number/conflicts` | read / reader | 3-way conflict view | PORT `merge-handlers.ts:158` |
| POST | `…/pulls/:number/resolve` | write / writer | Submit conflict resolution | PORT `merge-handlers.ts:213` |
| POST | `…/pulls/:number/merge` | write / maintainer | Merge `merge\|squash\|rebase` (CAS ref write + protection/approval gate) | PORT `merge-handlers.ts:50` + `merge-resolution.ts` |
| POST | `…/pulls/:number/reviews` | write / reader | Submit review `approved\|changes_requested\|commented` | PORT `reviews.ts:124` (**drop** `ai-review.ts`) |
| GET | `…/pulls/:number/reviews` | read / reader | List reviews | PORT `reviews.ts:231` |
| POST/GET | `…/pulls/:number/comments` | write·read / reader | Inline review comments (`file_path`,`line_number`) | PORT `comments.ts` |
| PATCH/DELETE | `…/pulls/comments/:id` | write / author\|maintainer | Edit/delete inline comment | NEW |

`POST …/ai-review` (`reviews.ts:279`) is **not ported** — agent-coupled, removed per decision record. Merge honors branch protection required approvals/checks before touching the refs-doc.

#### 4.8 Releases and assets

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `…/releases` / `…/releases/latest` / `…/releases/:tag` | read / reader | List/latest/get | PORT `release-crud.ts:27/102/164` |
| POST/PATCH/DELETE | `…/releases[/:tag]` | write / maintainer | Create/edit/delete (creates tag via §4.5 CAS) | PORT `release-crud.ts` |
| GET | `…/releases/:tag/assets` | read / reader | List assets | PORT `release-assets.ts:371` |
| POST | `…/releases/:tag/assets` | write / maintainer | Upload asset (streamed to R2 `release-assets/` prefix) | PORT `release-assets.ts` |
| GET | `…/releases/:tag/assets/:id/download` | read / reader | Download (streamed, real content-type) | PORT `release-assets.ts:257` |
| DELETE | `…/releases/assets/:id` | write / maintainer | Delete asset | PORT |

#### 4.9 Forks and upstream sync

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| POST | `…/fork` | write / reader | Fork into target owner (`{owner?,name?}`) | PORT `forks.ts:40` + `source/fork.ts` |
| GET | `…/forks` | read / reader | List forks | NEW |
| GET | `…/upstream` | read / reader | Ahead/behind vs parent (`checkSyncStatus`) | PORT `local/operations.ts` |
| POST | `…/upstream/sync` | write / writer | Fast-forward/merge from upstream (CAS ref write) | PORT `local/remote-fetch.ts` + `merge` |

#### 4.10 Webhooks (net-new)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET/POST | `…/hooks` | admin / owner | List / create (`url`, `secret`, `events[]`, `active`) |
| GET/PATCH/DELETE | `…/hooks/:id` | admin / owner | Get/edit/delete |
| POST | `…/hooks/:id/pings` | admin / owner | Send ping event |
| GET | `…/hooks/:id/deliveries` | admin / owner | Delivery log (status, duration, response) |
| GET | `…/hooks/:id/deliveries/:deliveryId` | admin / owner | Delivery detail + payload |
| POST | `…/hooks/:id/deliveries/:deliveryId/redeliver` | admin / owner | Retry delivery |

Delivery is async with retry + audit evidence (roadmap M3); signed with HMAC over the payload. Replaces Takos's `triggerPrEvent` (`pull-requests/routes.ts:98`) internal hook with a first-class subscription+delivery-ledger model.

#### 4.11 Workflows, runs, jobs, logs, artifacts (Actions)

Runner is **self-hosted inside takos-git** (Container + DO, decision record) — these routes dispatch to the in-worker runner DO, not an external runner Interface.

| Method | Path | Auth | Purpose | Prov. |
| --- | --- | --- | --- | --- |
| GET | `…/workflows` | read / reader | List parsed workflows | PORT `workflows.ts:187` |
| GET | `…/workflows/:path{.+}` | read / reader | Workflow detail | PORT `workflows.ts:238` |
| POST | `…/workflows/:path{.+}/dispatch` | write / writer | Manual dispatch (`{ref,inputs}`) | PORT dispatch of `actions/runs.ts:78` |
| GET | `…/actions/runs?workflow=&status=&branch=&event=` | read / reader | List runs (cursor) | PORT `actions/runs.ts:44` |
| GET | `…/actions/runs/:runId` | read / reader | Run detail | PORT `actions/runs.ts:122` |
| GET | `…/actions/runs/:runId/ws` | read / reader | Live log/status stream (WS/SSE) | PORT `actions/runs.ts:134` |
| POST | `…/actions/runs/:runId/cancel` | write / writer | Cancel | PORT `actions/runs.ts:147` |
| POST | `…/actions/runs/:runId/rerun` | write / writer | Re-run | PORT `actions/runs.ts:162` |
| GET | `…/actions/runs/:runId/jobs` | read / reader | Jobs of run | PORT `actions/runs.ts:187` |
| GET | `…/actions/jobs/:jobId` | read / reader | Job detail | PORT `actions/jobs.ts:18` |
| GET | `…/actions/jobs/:jobId/logs` | read / reader | Job logs (streamed) | PORT `actions/logs.ts` |
| GET | `…/actions/runs/:runId/artifacts` | read / reader | List artifacts | PORT `actions/artifacts.ts:17` |
| GET | `…/actions/artifacts/:id` | read / reader | Download artifact (R2 stream) | PORT `actions/artifacts.ts:39` |
| DELETE | `…/actions/artifacts/:id` | write / maintainer | Delete artifact | PORT `actions/artifacts.ts:80` |
| GET/PUT/DELETE | `…/actions/secrets[/:name]` | admin / owner | Encrypted secret CRUD (injected into runner) | PORT `actions/secrets.ts` |

The per-step exec contract (`{run,uses,with,env,shell,working-directory,continue-on-error,timeout-minutes}`, `takos/.../runtime/queues/workflow-steps.ts:35`) is preserved but its dispatch target changes from the 503 `RUNTIME_HOST` stub to takos-git's own runner DO/container. `.takos/workflows/*.yml` discovery path (`workflows.ts:166`) carries over.

#### 4.12 Check runs and commit statuses (net-new)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `…/commits/:sha/status` | read / reader | Combined status for commit |
| GET | `…/commits/:sha/statuses` | read / reader | Individual status contexts |
| POST | `…/commits/:sha/statuses` | admin / writer(app) | Publish a status (`state`, `context`, `target_url`, `description`) |
| GET/POST | `…/commits/:sha/check-runs` | read·admin / reader·writer(app) | List / create check run |
| PATCH | `…/check-runs/:id` | admin / writer(app) | Update check-run status/conclusion/output |
| GET | `…/check-runs/:id` | read / reader | Check-run detail |

The internal self-hosted runner publishes check-runs through this same API using a scoped credential, so branch-protection "required checks" (§4.3) reads a uniform source whether the check came from the built-in runner or an external automation bearer.

### 5. Migration notes

- **Prefix rewrite is mandatory and non-optional**: every ported handler currently keyed on `:repoId`/`:spaceId` (`checkRepoAccess`, `requireSpaceAccess`, `requireRepoRead/Write/Admin`) is rewritten to resolve `:owner/:repo` and to consult the new app-local ACL, severing the `accounts`/`Space` FK and `resolveOwnerUsername` (`takos/.../repos/repo-utils.ts`). No `shared/types` Takos RPC types cross into takos-git (`docs/collaborative-hosting.md:119`).
- **Net-new builds** (no Takos source to port): collaborators/teams ACL & roles, real branch protection, issues/labels/milestones, webhooks + deliveries, check-runs/commit-statuses, `/raw`, code search (text), single-commit and `compare` routes.
- **Dropped**: `ai-review` (`reviews.ts:279`) and the semantic/embedding index half of `git-advanced.ts:265` — both agent-coupled.
- **Handler mounting**: replace the monolithic `switch` in `handleForgeApi` (`src/forge-api.ts:511`) with a small method+segment router table; keep the single `authorize`/error-envelope/pagination helpers shared across all groups so web and automation continue to traverse identical code with only the front identity middleware differing.

---

I have everything I need. Writing the spec section now.

## Web SPA architecture

takos-git today has no browser application. `src/worker.ts:81-264` (`gitConsoleHtml`) is a single inline‑HTML string that renders a JSON‑dumper console: it hard‑codes an `owner/repo` text box, fires raw `fetch()` calls at the read API, and prints the JSON into a `<pre>` (`src/worker.ts:174-176`). It is served from the worker's `html()` helper at `src/worker.ts:346-351` under a strict inline CSP (`src/worker.ts:73-74`: `script-src 'unsafe-inline'; style-src 'unsafe-inline'`). There is no Vite app, no `web/` directory, no static‑asset binding, and no bundler wired to a build (only `scripts/build-worker.ts` produces `dist/worker.js`). This section specifies replacing that console with a real GitHub‑like SPA and porting the Takos code‑browser views into it.

### Framework choice: SolidJS + Vite (ecosystem‑confirmed)

Every browser surface in the ecosystem is SolidJS on Vite with `vite-plugin-solid`:

- **takosumi dashboard** — `solid-js` + `@solidjs/router` + `vite-plugin-solid` + `vite` (`takosumi/dashboard/package.json`), served from a Workers static‑assets binding.
- **takos web** — `solid()` + `@tailwindcss/vite` (`takos/web/vite.config.ts`), the exact app that owns the repo views we are porting.
- **yurucommu / yurumeet** — same Solid + Vite stack.

The views to port (`takos/web/src/views/repos/**`) are already SolidJS `.tsx` authored against Tailwind utility classes (e.g. `RepoDetail.tsx:354` `class="flex flex-col h-full bg-zinc-50 dark:bg-zinc-900"`). Rewriting them into any other framework would be a full rewrite for zero benefit. **Decision: SolidJS + Vite + `vite-plugin-solid` + `@tailwindcss/vite` (Tailwind v4), matching `takos/web`.** This keeps the ported components' `class="…"` and `dark:` variants working unchanged, and keeps takos‑git consistent with the rest of the fleet so a single reviewer can move between apps.

The router is `@solidjs/router` (as the dashboard uses it — `takosumi/dashboard/src/index.tsx:3-10`, lazy routes). Icons: **port `takos/web/src/lib/Icons.tsx` verbatim** — it is a dependency‑free hand‑rolled SVG set (`Icons.tsx:1-20`, `stroke="currentColor"`), so porting it keeps every `Icons.X` call site in the repo components intact and avoids adding `lucide-solid` as a dependency.

### 1. How the worker serves the built SPA

**Decision: native Cloudflare Workers static‑assets binding (`ASSETS`), worker‑first routing, with the worker attaching CSP/security headers to asset responses.** Reject bundling the SPA into `worker.js` (a GitHub‑parity SPA of code browser + diff + PR + Actions views is hundreds of KB–~1 MB and would bloat the security‑critical git/auth worker toward the 10 MB script ceiling and into every cold‑start), and reject a separate assets R2 bucket (no edge cache, manual content‑types, extra moving parts).

This is the proven ecosystem pattern:

- takosumi dashboard: `takosumi/deploy/platform/wrangler.toml:31-34` — `[assets] directory = "../../dashboard/dist"`, `binding = "ASSETS"`, `not_found_handling = "single-page-application"`.
- takos: `takos/deploy/cloudflare/wrangler.toml:101-103` — `[assets] directory = "../../dist"`, `binding = "ASSETS"`.

**Routing model.** takos‑git's worker owns `/git/*`, `/api/*`, `/mcp`, `/healthz`, `/.well-known/*` and must never let the SPA fallback swallow those. So the SPA cannot be served ahead of the worker. Set **`run_worker_first = true`**: the worker is invoked for every request, dispatches its own routes exactly as today (`worker.ts:340-441`), and for any remaining GET/HEAD returns `await env.ASSETS.fetch(request)`. Deep client‑side links (`/owner/repo/pulls/3`) resolve because `not_found_handling = "single-page-application"` makes the ASSETS binding return `index.html` for unmatched paths.

Concrete worker changes in `src/worker.ts`:

- Add `ASSETS: Fetcher` to `Env` (`worker.ts:32-42`).
- Delete `gitConsoleHtml` (`worker.ts:81-264`), the `html()` helper (`worker.ts:68-79`), and the `GET / | /ui` branch (`worker.ts:346-351`).
- Drop the bespoke icon special‑case (`worker.ts:30` `iconSvg` import, `worker.ts:50` `ICON_PATH`, `worker.ts:343-345`): move `public/icons/takos-git.svg` into `web/public/icons/` so ASSETS serves it as an ordinary static file — the launcher Interface's `/icons/takos-git.svg` URL still resolves against the worker origin (worker‑first forwards it to ASSETS).
- Add a terminal fallback after all API/git routes miss:

  ```ts
  if (request.method === "GET" || request.method === "HEAD") {
    return withAppSecurityHeaders(await env.ASSETS.fetch(request));
  }
  ```

**CSP.** Keeping asset delivery worker‑first lets CSP stay centralized in `worker.ts` exactly as the current posture (`worker.ts:73-74`) rather than depending on a `_headers` file. `withAppSecurityHeaders` clones the ASSETS response and sets:

```
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'self';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'
x-content-type-options: nosniff
referrer-policy: no-referrer
```

The migration is a genuine CSP **hardening**: Vite emits external, content‑hashed JS, so `script-src` drops the current `'unsafe-inline'` (`worker.ts:74`) and becomes `'self'`. `style-src` keeps `'unsafe-inline'` because the ported views use dynamic inline `style=` attributes (diff column sizing, progress bars); this can be tightened to hashes later. `connect-src 'self'` is correct — the SPA only ever calls same‑origin `/api/*`. `index.html` itself carries no CSP `<meta>` (unlike `takos/web/index.html`); the worker is the single source of the header.

### 2. App routing (`@solidjs/router`)

GitHub‑parity URL scheme so links are shareable and deep‑linkable. `NavLink`/`A` replace the Takos shell's `onBack`/imperative nav callbacks (`RepoDetail.tsx:110` `onBack`, `:363`).

| Route | View | Milestone |
| --- | --- | --- |
| `/` | `RepoListView` (workspace repo index) | M1 |
| `/new` | `NewRepoView` | M2 |
| `/settings` | workspace/user settings | M2 |
| `/:owner/:repo` | `RepoDetail` → code tab, default branch | M1 |
| `/:owner/:repo/tree/:ref/*path` | code browser at path | M1 |
| `/:owner/:repo/blob/:ref/*path` | `FileViewer` | M1 |
| `/:owner/:repo/commits/:ref?` | `CommitList` | M1 |
| `/:owner/:repo/commit/:sha` | commit diff (`PRDiffView` reused) | M2 |
| `/:owner/:repo/branches` | `BranchesTab` | M1 |
| `/:owner/:repo/issues` `/issues/:number` | Issues (build fresh) | M2 |
| `/:owner/:repo/pulls` `/pulls/:number` `/pulls/:number/files` | `PRList` / `PRDetail` / `PRDiffView` | M2 |
| `/:owner/:repo/compare/:base...:head` | new PR | M2 |
| `/:owner/:repo/releases` | `ReleaseList` | M2 |
| `/:owner/:repo/actions` `/actions/runs/:runId` | `ActionsTab` / `RunDetail` | M3 |
| `/:owner/:repo/settings` | repo settings / ACL / branch rules | M2 |

`:owner/:repo` are flat‑string path segments today (one owner, one name inside `APP_WORKSPACE_ID`), so the current tab‑switch state in `RepoDetail.tsx:120` (`activeTab` signal) is lifted to route segments; the tab bar (`RepoDetail.tsx:452-480`) becomes `<A>` links. Entry point `web/src/index.tsx` mounts `<Router>` with an `<AppShell>` root layout (top bar with repo breadcrumb + session widget) wrapping lazy‑loaded route views — mirroring `takosumi/dashboard/src/index.tsx:44-64`'s `lazy(() => import(...))` pattern, so the diff/PR/Actions view code is not in the initial bundle.

### 3. Store / i18n / toast / confirm‑dialog shims to reprovide locally

All four Takos stores are **self‑contained SolidJS module singletons with zero shell/chat/agent coupling** — they port by copying the file and its tiny util deps into `web/src/store/` and `web/src/lib/`:

- **toast** — `takos/web/src/store/toast.ts` is a module‑level `createSignal<Toast[]>` with `useToast()` (`showToast`/`dismissToast`/pause/resume). Copy verbatim; port its `Toast` type; port the shell's Toast render host as `web/src/components/ToastHost.tsx` mounted once in `AppShell`.
- **confirm‑dialog** — `takos/web/src/store/confirm-dialog.ts` is a module singleton exposing `useConfirmDialog().confirm(opts): Promise<boolean>` plus `useConfirmDialogState()`/`useConfirmDialogActions()` (`confirm-dialog.ts:31-60`). Copy verbatim; port the render host as `web/src/components/ConfirmDialogHost.tsx` (consumes the state/actions singletons) mounted in `AppShell`. `RepoDetail.tsx:277-283` (`confirm({ title, message, danger })`) works unchanged.
- **i18n** — `takos/web/src/store/i18n.ts` (`useI18n()` → `t`/`tOr`/`lang`/`setLang`) is backed by `getTranslation` + per‑domain dictionaries. Port `store/i18n.ts`, `lib/locale.ts` (`detectLanguage`, `LANGUAGE_STORAGE_KEY`), `lib/storage-atom.ts` (`createPersistedSignal`), and the `getTranslation` dispatcher, but **only the `repository` dictionary** — `takos/web/src/i18n/{en,ja}/repository.ts` (222/223 keys each) — plus the handful of `common` keys the repo views call (`t("delete")`, `t("unknownError")`). Drop `agent.ts`/`chat.ts`/`deploy.ts`/etc. Keep EN + JA (JA is the user's canon).
- **utility shims** the views import: `lib/Icons.tsx`, `lib/a11y.ts` (`moveTabFocus`, `RepoDetail.tsx:11`), `lib/safeHref.ts` (`toSafeHref`, `RepoDetail.tsx:26`), `lib/withTimeout.ts`. All are dependency‑free.

These are pure UI primitives; none reach into the Takos global store, navigation context, chat, or agent surfaces. The only Takos store the repo views touch that is **not** ported is `store/navigation` (shell routing) — replaced by `@solidjs/router`.

### 4. Auth wiring to `/api/auth/session`

The SPA authenticates **only** through the browser OIDC cookie session — it never sees Interface OAuth `taksrv_` bearers (those stay unmixed on the Git‑CLI / automation path per `docs/collaborative-hosting.md:57-66`). Concretely:

- An `AuthProvider` context (`web/src/store/session.ts`) calls `GET /api/auth/session` on mount with `credentials: "same-origin"` and exposes `{ authenticated, configured, user }` — the exact shape the current console reads at `worker.ts:190-198`.
- All API calls use `credentials: "same-origin"` (cookie only); **the SPA carries no token‑paste field** — the console's `taksrv_…` password input (`worker.ts:147-155`, `token` header at `worker.ts:170-173`) is deleted. Interface credentials are a CLI concern, surfaced only as a copyable `git clone` hint, not a browser auth input.
- Unauthenticated → render a public shell with a **Sign in** link to `/api/auth/login?return_to=<current path>` (`worker.ts:121`). `configured === false` (OIDC unset) → "sign‑in unavailable" state, matching `worker.ts:196`.
- Sign out → `POST /api/auth/logout` then reload (`worker.ts:203-206`).
- **Authorization is binary in M1**: session membership in the single `APP_WORKSPACE_ID` is the only gate; there is no per‑repo role yet. `RepoDetail`'s `isAuthenticated`/`onRequireLogin` props (`RepoDetail.tsx:151`, `:242-245`) map to "signed‑in member vs not". Write‑capable chrome (star, fork, delete, PR merge) renders only when authenticated **and** the corresponding write API exists (M2); until then those buttons are hidden, not shown‑then‑403. When per‑repo ACL lands (M2, `collaborative-hosting.md:68-70`), the session response gains a per‑repo `permission` field and the same props switch on it.

### 5. Component inventory + port/rewrite verdict

Source root: `takos/web/src/views/repos/`. The decoupling operation for every "port" row is identical: swap `lib/rpc` → local `lib/api` (see §6 below), keep `store/*` (ported), keep `lib/Icons`/`lib/a11y`/`lib/safeHref`, port the referenced `types`. No component imports chat/agent/shell nav.

| Component | Verdict | Notes |
| --- | --- | --- |
| `components/RepoDetail.tsx` | **Port** (orchestrator) | Lift tab state to routes; `onBack`→`<A>`; metadata chrome (stars `:389-402`, forks `:403-417`, visibility badge `:377-385`, description `:421-425`, `forked_from` `:427-449`) is **data‑gated** — hidden in M1 (flat `owner/name`, no D1 metadata), rendered once M2 metadata exists. Star/delete write calls (`:254-260`, `:287-289`) → M2. |
| `components/FileTree.tsx` | **Port** | R2 tree read; maps to `GET /api/v1/repos/:o/:r/tree`. |
| `components/FileViewer.tsx`, `CodeViewer.tsx`, `FileContentRenderer.tsx`, `FileViewerToolbar.tsx` | **Port** | Blob viewer; maps to `GET .../blob`. Honor the 1 MiB / base64 blob contract (`collaborative-hosting.md:149-152`). |
| `components/CommitList.tsx` | **Port** | `GET .../commits?ref=&limit=`. |
| `components/BranchesTab.tsx`, `RepoDetailBranches.tsx` | **Port** | `GET .../branches`. |
| `components/RepoDetailFiles.tsx`, `RepoDetailReadme.tsx`, `RepoDetailSidebar.tsx` | **Port** | Code‑tab composition; README candidate probe (`RepoDetail.tsx:52-102`) reused as‑is. |
| `components/PRList.tsx`, `PRDetail.tsx`, `PRHeader.tsx`, `PRComments.tsx`, `PRActions.tsx` | **Port (M2)** | Bind to new takos‑git PR API; drop any AI‑review affordance. |
| `components/PRDiffView.tsx` | **Port (M2)** | Reused for both PR files and `/commit/:sha`. |
| `components/ConflictResolver.tsx` | **Port (M2)** | Backed by the ported path‑level 3‑way merge; no shell coupling. |
| `components/ReleaseList.tsx` | **Port (M2)** | Release CRUD + assets API. |
| `components/ForkModal.tsx` | **Port (M2)** | Fork API. |
| `components/FileHistoryModal.tsx`, `UpstreamSyncWidget.tsx`, `RepoCodeSearch.tsx` | **Port, gated** | FileHistory + UpstreamSync = M2; RepoCodeSearch needs the async code index → **M3** (hide the Search tab, `RepoDetail.tsx:315-319`, until then). |
| `components/ActionsTab.tsx` + `components/actions/{RunsList,RunDetail,JobCard,DispatchWorkflowForm}.tsx` | **Port (M3)** | Bind to takos‑git's self‑hosted runner API; hide the Actions tab pre‑M3. |
| `RepoDetailPage.tsx`, `ReposPanel.tsx`, `RepoCollection.tsx`, `RepoSearchResults.tsx`, `RepoBrowseCard.tsx` | **Rewrite** | These are **Takos‑shell** surfaces (embedding repos into the workspace UI + cross‑workspace search). Replace with a takos‑git‑native `RepoListView` (workspace repo index → `GET /api/v1/repos`) and `NewRepoView`. Do not port the shell embedding. |
| `ai-review.ts` and any AI‑review UI | **Drop** | Agent‑coupled, per the decision record. |

### 6. Local API client, `web/` location, build/dev, main.tf & wrangler

**Sever the RPC layer.** `takos/web/src/lib/rpc.ts` binds to Takos internals: `hc<ApiRoutes>("/api")` (Hono client) typed from `takos-api-contract/rpc-types` (`rpc.ts:1-33`) plus the loose `rpcPath` proxy walk (`rpc.ts:83-88`), and it pulls the Takos i18n for error messages. takos‑git's `/api/v1` is **plain GET‑only REST** (`src/forge-api.ts`), not a Hono‑typed contract. **Decision: do not port `lib/rpc.ts`.** Write a thin typed fetch client `web/src/lib/api.ts` (same‑origin, `credentials: "same-origin"`, `withTimeout`) whose method surface mirrors the forge routes (`/api/v1/repos`, `/:owner/:repo`, `/branches`, `/commits`, `/tree`, `/blob`), returning DTOs from a ported `web/src/lib/types.ts` (the `Repository`/`Branch`/`Commit`/`FileDiff`/`PullRequest`/`PRComment`/`PRReview` subset from `takos/web/src/types/index.ts`). M2/M3 write routes extend the same client with POST/PATCH/DELETE. No `hono/client`, no `takos-api-contract` alias, no Takos RPC types enter `web/`.

**Location.** A dedicated Vite app at `takos-git/web/`, output to `takos-git/web/dist/` — mirroring `takos/web` and `takosumi/dashboard`. Structure: `web/index.html` (`<div id="root">` + `<script type="module" src="/src/index.tsx">`, no CSP `<meta>`), `web/src/{index.tsx,routes/,views/,components/,store/,lib/,i18n/}`, `web/public/icons/takos-git.svg`, `web/vite.config.ts`, `web/tsconfig.json`, `web/package.json`.

**`web/package.json`**: deps `solid-js`, `@solidjs/router`; devDeps `vite`, `vite-plugin-solid`, `@tailwindcss/vite`, `tailwindcss`, `typescript`. `vite.config.ts` follows `takos/web/vite.config.ts` — `plugins: [solid(), tailwindcss()]`, `build.outDir` → `web/dist`, and a dev proxy so the SPA hits the local worker:

```ts
server: { host: true, proxy: { "/api": WORKER, "/git": WORKER, "/mcp": WORKER, "/healthz": WORKER } }
```

with `WORKER = http://localhost:8787` (the `wrangler dev` worker). No cross‑repo Vite aliases (unlike `takos/web`, which aliases into `../src/contracts` and `../../takosumi/...`): takos‑git is standalone, so `web/` has zero path aliases into other repos — its only contract with the worker is the same‑origin HTTP surface.

**Root `takos-git/package.json` scripts** (extend the current `build:worker`/`test`/`check` set):

```jsonc
"dev:web":    "cd web && vite",
"build:web":  "cd web && vite build",
"build":      "bun run build:web && bun run build:worker"
```

`scripts/build-worker.ts` is unchanged; `build` now produces both `web/dist/` (SPA) and `dist/worker.js` (worker). `bunx tsc --noEmit` gains a `web/tsconfig.json` project.

**wrangler (local dev + self‑host wrangler step).** Add an assets block so the worker serves the SPA:

```toml
main = "dist/worker.js"
[assets]
directory = "web/dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"
```

`run_worker_first = true` is load‑bearing: without it the SPA fallback would shadow `/api` and `/git`. This matches the platform pattern (`takosumi/deploy/platform/wrangler.toml:31-34`) but adds `run_worker_first` because — unlike the dashboard — takos‑git's worker owns non‑asset routes at the same origin.

**main.tf (OpenTofu).** `cloudflare_workers_script.worker` (`main.tf:308-405`) gains an `assets` configuration alongside the existing `bindings` array (`main.tf:319-372`):

- Add `binding_type = "assets"` / the provider's `assets = { config = { run_worker_first = true, not_found_handling = "single-page-application", html_handling = "auto-trailing-slash" }, jwt = <upload-session-token> }` to the script resource. The Cloudflare provider requires the SPA files to be uploaded via the two‑phase Workers Assets upload (obtain an upload session, PUT the hashed files, receive a completion JWT), then referenced from the script — heavier than the current single‑`worker.js` upload.
- Extend the release‑artifact contract: today `main.tf:270-300` downloads a single `worker.js` selected by `takosumi-artifact.json` (`main.tf:272`, verified by SHA‑256 at `main.tf:396-398`). The SPA must ship in the release too — extend `takosumi.worker-artifact@v1` (`main.tf:388`) to reference an `assets` payload (tarball of `web/dist` + per‑file SHA‑256 manifest) next to the worker bundle, so the OpenTofu apply uploads both atomically and the artifact stays integrity‑verified.
- Gate behind a new `enable_web` variable (default `true`) so a headless self‑host that only wants Git Smart HTTP can skip the SPA; when `false`, the worker's ASSETS fallback simply isn't wired and only `/git`/`/api`/`/mcp` are served.

Because the worker is worker‑first and re‑emits CSP around every ASSETS response, no `_headers` file is required; if the OpenTofu two‑phase asset upload proves too heavy for a given operator, a `_headers` file in `web/dist` is the documented fallback for setting the same CSP, but the worker‑wrap remains the canonical, code‑reviewed source of the policy.

---

## Self-hosted Actions runner

> **Status:** M3 capability, opt-in. This section is the authoritative design for the CI runner and **overrides** the "runner Interface を使う Actions dispatch" wording in `docs/collaborative-hosting.md:95` (see §7 for the rewrite). The runner is embedded in takos-git's own Worker + `main.tf`; it is **not** an external runner Capsule, **not** a Takosumi `Runner`, and **not** the Takos agent.

### Design decision and invariants

The runner mirrors the proven Takosumi container pattern — a **coordinator Durable Object** (Takosumi's `OpenTofuRunOwnerObject`) plus a **Cloudflare-Container Durable Object** (Takosumi's `OpenTofuRunnerObject`, `takosumi/worker/src/durable/OpenTofuRunnerObject.ts:185`) reached over a `Namespace.idFromName(runId).fetch()` seam with capacity-retry and redaction (`takosumi/worker/src/container_runner.ts:382-472`). It reuses the takos-computer sandbox image approach (`takos-apps/takos-computer/apps/sandbox/Dockerfile`: `oven/bun` base + `git curl jq build-essential python3`, non-root `sandbox` user) and the pure, portable `takos-actions-engine` (parser/scheduler/matrix/dependency — already vendored in the Takos legacy tree the roadmap migrates from).

Non-negotiable invariants carried into this design:

- **Git objects + refs stay authoritative in the git `BUCKET`.** Actions logs and artifacts live in a *separate* bucket; the runner never writes Git objects except the transient run-pin ref (below), which goes through the normal per-repo refs-doc ETag CAS boundary.
- **The three auth mechanisms stay unmixed.** Browser OIDC (`browser-auth.ts`) and Interface OAuth (`interface-oauth-auth.ts`) are untouched. The runner introduces a **fourth, internal-only, non-customer** credential — a run-scoped HMAC token on `/internal/actions/*` routes — reserved exactly the way Takosumi reserves `/internal/*` for runner callbacks (Takosumi `AGENTS.md`: "`/internal/*` … reserved for opentofu-runner / executor container callbacks"). It is never advertised as a customer auth mode and never accepted on `/api/v1`, `/git/`, or `/mcp`.
- **GHA wire-compat is a non-goal.** The step vocabulary is honored (§2); the REST/webhook surfaces are versioned takos-git capabilities, not GitHub API mirrors.
- **Actions is gated by `enable_actions`.** When false, takos-git remains today's single-file, R2-only Worker with no Container/DO/Queue bindings (`main.tf:302-420`). Turning it on is what breaks the "single-file worker" shape — deliberately, and only for installers who want CI.

### 1. Topology — event → run → jobs → container

```text
push / PR event (worker, in-process)
  │  parse workflow YAML via takos-actions-engine (parser/workflow.ts + validator.ts)
  │  expand matrix + build needs-DAG (scheduler/{matrix,dependency,job-expansion}.ts)
  │  pin the exact commit SHA; write refs/takos-actions/<runId> (refs-doc CAS)
  │  INSERT workflow_run + workflow_jobs + check_runs rows (D1, status=queued)
  ▼
WORKFLOW_QUEUE  ──(DLQ: WORKFLOW_DLQ after max_retries)
  │  one message per run-tick: { runId, repoId }
  ▼
queue consumer (worker)  ──►  ACTIONS_RUN.idFromName(runId)      [coordinator DO, SQLite]
                                 owns: job DAG gate (needs:), concurrency group,
                                 cancellation, per-job/step timeout alarms,
                                 status projection to D1, log fan-out (WebSocket)
                                 │  for each job whose needs are satisfied:
                                 ▼
                              ACTIONS_JOB.idFromName(jobId)       [Container DO]
                                 = Cloudflare Container running the runner image
                                 1. GET /internal/actions/checkout/<runId> → clone pinned ref
                                 2. execute steps in-workspace (the step loop, §2)
                                 3. stream logs → POST /internal/actions/logs/<jobId>
                                 4. return per-step results {conclusion,exitCode,outputs}
```

**Why a coordinator DO and not just the queue.** `needs:` ordering, `concurrency:` groups, fan-in fan-out, cancellation, and timeout alarms are all *run-scoped serialized state* — exactly what a single-writer DO gives you, and exactly the role `OpenTofuRunOwnerObject` plays for Takosumi. The Queue is the durable retry buffer (at-least-once, visibility-timeout re-drive) so a coordinator or container crash re-drives the run tick rather than losing it; the coordinator makes every projection idempotent on `(runId, jobId, attempt)`.

**Why one container per *job*, not per *step*.** Steps in a job share a filesystem/workspace and `steps.<id>.outputs` handoff. The Takos legacy code round-trips **per step** to a `RUNTIME_HOST` binding that is a 503 stub (`takos/src/worker/runtime/queues/workflow-steps.ts:25-32`, `takos/containers/runtime/src/runtime-service.ts`). We **collapse that round-trip**: the DO dispatches the whole job (checkout spec + ordered step list + env + secrets) to the container once, and the *step loop moves inside the container*. This deletes the `RUNTIME_HOST` seam entirely and keeps step-to-step state (`state.stepOutputs`, working directory, files) local — the natural GHA job model.

**Checkout without mixing auth.** At projection time the coordinator pins the immutable commit and writes a hidden ref `refs/takos-actions/<runId>` via the same conditional refs-doc R2 write that receive-pack uses (so it is atomic and reuses `src/git/refs-store.ts`). The branch/commit APIs (`forge-api.ts`) filter the `refs/takos-actions/` namespace out. The container fetches that ref from `/internal/actions/checkout/<runId>`, an internal route that (a) requires the run-scoped HMAC bearer, (b) is read-only, and (c) resolves only that run's pinned ref — so no `allowAnySHA1InWant` protocol change and no reachability-guessing exposure (the M1 "branch-name-only browse" invariant, `docs/collaborative-hosting.md:149`, is preserved). The coordinator deletes the pin ref (CAS) when the run reaches a terminal state.

### 2. Per-step execution contract

The Takos `RUNTIME_HOST` step message (`takos/src/worker/runtime/queues/workflow-steps.ts:35-54`) is **preserved verbatim as the per-step element** of the job dispatch body, but consumed *inside* the container instead of over the network:

```jsonc
// POST (DO → container)  https://actions-runner.internal/jobs/<jobId>
{
  "kind": "takos-git.actions-job@v1",
  "runId": "...", "jobId": "...", "attempt": 1,
  "checkout": { "url": "/internal/actions/checkout/<runId>", "ref": "refs/takos-actions/<runId>", "commit": "<sha40>" },
  "job": { "env": { ... }, "defaults": { "shell": "bash", "working-directory": "." },
           "container": null, "services": [] },
  "secrets": [ { "name": "NPM_TOKEN", "value": "***" } ],   // never logged; feeds redaction table
  "workloadToken": "***",                                    // TAKOS_GIT_TOKEN, run-scoped, checks:write+contents:read
  "steps": [
    { "name": "build", "run": "bun install && bun run build",
      "uses": null, "with": null, "env": { "CI": "true" },
      "shell": "bash", "working-directory": ".",
      "continue-on-error": false, "timeout-minutes": 30 }
  ]
}
```

Each step is dispatched to the same in-container executor that Takos already wrote, keeping the exact field set `{ run, uses, with, env, name, shell, working-directory, continue-on-error, timeout-minutes }`. The executor:

- `run` → spawn under the resolved `shell` in `working-directory`, inheriting job env + step env + `secrets` + `TAKOS_GIT_TOKEN` + GHA-shaped context vars (`GITHUB_SHA`, `GITHUB_REF`, `GITHUB_WORKSPACE`, `RUNNER_TEMP`, `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STEP_SUMMARY`). Reads back `$GITHUB_OUTPUT`/`$GITHUB_ENV` to populate `steps.<id>.outputs` and mutate later-step env — the sequential-mode semantics of `workflow-types.ts` `state.stepOutputs`.
- `uses` → resolved by the capability handler in §6 (not `docker run` of arbitrary marketplace actions).
- Per-step return shape is unchanged from the legacy `StepExecutionResult` / `RuntimeStepResponse` (`{ success, exitCode, stdout, stderr, outputs, error }`), and job `conclusion` uses the engine's `Conclusion = "success" | "failure" | "cancelled" | "skipped"` (`takos/src/worker/actions-engine/workflow-models.ts:380`). `continue-on-error` and `timeout-minutes` retain their legacy meaning; timeout is enforced *twice* — a hard `AbortSignal` in-container and a coordinator DO alarm as the outer backstop (§3).

### 3. Runtime concerns

**Log streaming + persistence.** The container flushes NDJSON log lines (`{ jobId, stepIndex, stream, ts, text }`) to `POST /internal/actions/logs/<jobId>` in small batches. The coordinator DO (a) appends to an in-DO ring buffer and broadcasts to subscribed browser WebSocket clients using DO hibernation (live-tail), and (b) on job completion seals the full ordered log to R2 at `logs/<repoId>/<runId>/<jobId>.log`. All log text passes through a redactor seeded from the `secrets[].value` set and the workload token, mirroring `redactRunnerOutput` / `redactString` (`takosumi/runner/lib/http_server.ts:117`, `takosumi/worker/src/container_runner.ts:831`). Live WebSocket lines are redacted *before* fan-out, not only at seal time.

**Artifact upload to R2.** `actions/upload-artifact`-shaped uploads (§6) stream from the container to `PUT /internal/actions/artifacts/<runId>/<name>`; the worker verifies the run-scoped bearer + size cap and stores at `artifacts/<repoId>/<runId>/<name>.zip` with SHA-256 in `customMetadata`, using the retrying-put pattern (`putR2ObjectWithRetry`, `OpenTofuRunnerObject.ts:1303`). Download is authorized through the normal browser/Interface-OAuth path on `/api/v1/repos/:owner/:repo/actions/runs/:id/artifacts/:name`.

**Status projection.** check_runs and commit statuses are **built fresh** (absent everywhere today). The state machine is single-owner in the coordinator DO and projected to D1 idempotently:

| runner event | `check_runs.status` | `check_runs.conclusion` | combined commit status |
| --- | --- | --- | --- |
| job enqueued | `queued` | — | `pending` |
| container dispatched | `in_progress` | — | `pending` |
| all steps ok | `completed` | `success` | recompute → `success` when all pass |
| step failed (no continue-on-error) | `completed` | `failure` | `failure` |
| cancelled / concurrency-superseded | `completed` | `cancelled` | `failure` |
| timeout alarm fired | `completed` | `timed_out` (maps to `failure` in commit status) | `failure` |

The commit-status API is the derived "combined status" for a SHA (a takos-git capability surface, versioned `checks.v1`), not a GitHub statuses-API mirror.

**Secret injection + redaction.** Repo/workspace-scoped Actions secrets are stored encrypted in D1 (write-only to the API, redacted from reads — same rule as Takosumi `Secret`). The coordinator decrypts *only* the secrets referenced by the run and passes them in the DO→container body (which is buffered, never logged — `bufferedResponse`, `OpenTofuRunnerObject.ts:1378`). Secrets are set as process env for `run:` steps only, deleted with the container, and never surface in `outputs`, artifacts, logs, or the run ledger. `blockSensitiveOutputs` (below) rejects any step `output` whose value equals a known secret.

**Network / resource policy (mirror `RunnerProfile`).** The runner ships a fixed `ActionsRunnerProfile` shaped after `RunnerProfile` (`takosumi/contract/internal-deploy-control-api.ts:106-181`):

```jsonc
{
  "networkPolicy":       { "mode": "egress-allowlist",
                           "allowedHosts": ["<worker-internal-checkout-host>"],
                           "allowedHostPatterns": [] },      // default-deny; installer may widen
  "resourceLimits":      { "cpu": "1", "memoryMb": 2048, "maxSourceDecompressedBytes": … },
  "secretExposurePolicy":{ "providerCredentials": "runner-only",
                           "tenantWorkerOperatorSecrets": "forbidden",
                           "redactLogs": true, "blockSensitiveOutputs": true },
  "concurrency": 20
}
```

`resourceLimits` map to the Container `instance_type` and to per-step ulimits; `networkPolicy` is enforced at the container (egress default-deny except the internal checkout host, plus any installer allowlist for package registries). This is a **fixed embedded profile**, not the operator `/internal/v1/runner-profiles` seam — takos-git owns it.

**Cancellation, timeout, concurrency.**
- *Cancellation* — UI/API cancel flips the coordinator run state; the coordinator signals each live `ACTIONS_JOB` DO to `destroy()` its container (`#shutdownContainerIfSupported`, `OpenTofuRunnerObject.ts:326`) and projects `cancelled`.
- *Timeout* — the coordinator sets DO alarms per `timeout-minutes` (job) and a run-level ceiling; a fired alarm destroys the container and projects `timed_out`. The container also self-aborts as the fast path.
- *Concurrency* — a workflow `concurrency: { group, cancel-in-progress }` is a serialized decision in `ACTIONS_RUN.idFromName(hash(repoId+group))`: a new run in a group with `cancel-in-progress` cancels the older run before dispatch. Container capacity pressure ("maximum number of running container instances exceeded") is handled with the exact backoff-retry loop from `container_runner.ts:437-467`.

### 4. Container image

A dedicated `takos-git/containers/runner/Dockerfile`, following the sandbox image (`takos-apps/takos-computer/apps/sandbox/Dockerfile`) but with a CI toolset:

```dockerfile
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git git-lfs curl jq unzip zip xz-utils \
      build-essential python3 python3-pip openssh-client \
    && rm -rf /var/lib/apt/lists/*
# Node for actions ecosystems that assume it; Bun stays primary.
RUN curl -fsSL https://nodejs.org/... && …            # pinned LTS, checksum-verified
WORKDIR /work
COPY containers/runner/ /app/runner/
RUN groupadd -r runner && useradd -r -g runner -m runner && chown -R runner:runner /work
USER runner
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/runner/start.sh"]     # bun /app/runner/server.ts
```

`/app/runner/server.ts` is the in-container HTTP server, ported from `takosumi/runner/lib/http_server.ts`: `GET /healthz`, `POST /jobs/<jobId>` (dispatch), plus the artifact/log-flush client. It embeds the step executor (the ported `workflow-steps.ts` loop) and the `uses:` capability handlers (§6). The DO class matches the Takosumi container DO contract — `defaultPort = 8080`, `requiredPorts = [8080]`, `pingEndpoint`, `sleepAfter`, `entrypoint`, `startAndWaitForPorts` readiness with the same 3-attempt "container is not running" retry (`OpenTofuRunnerObject.ts:353-389`), and `onActivityExpired`/`destroy` teardown after each job. Image ships **git, git-lfs, bun, node, python3, and a C toolchain** — enough for the common `install → build → test` job without pulling arbitrary marketplace actions.

### 5. Exact new bindings and resources

Container provisioning requires a **Workers Paid plan + Containers**, an image built and pushed in takos-git CI (not fetched by `data.http` like the Worker bundle), and OpenTofu/wrangler container support. This is why Actions is gated: `enable_actions=false` keeps `main.tf` at today's R2-only shape.

**Worker `Env` additions** (`src/worker.ts:29-40`), all optional/undefined when Actions is off:

```ts
ACTIONS_DB: D1Database;                        // shared with collaboration-core D1 (workflow_run/jobs/check_runs/secrets)
WORKFLOW_QUEUE: Queue<{ runId: string; repoId: string }>;
WORKFLOW_DLQ: Queue;                           // dead-letter after max_retries
ACTIONS_RUN: DurableObjectNamespace;           // coordinator DO (SQLite)
ACTIONS_JOB: DurableObjectNamespace;           // Container DO (the runner image)
R2_ACTIONS: R2Bucket;                          // logs/ + artifacts/ prefixes; git BUCKET untouched
ACTIONS_RUNNER_SECRET: string;                 // HMAC key for /internal/actions/* + run-scoped tokens
ACTIONS_SECRETS_KEY: string;                   // AES key for Actions secret encryption at rest
```

**wrangler shape** (the containers/DO/queue/migrations blocks that OpenTofu must reproduce):

```jsonc
{
  "containers": [
    { "class_name": "ActionsJobRunner", "image": "./containers/runner/Dockerfile",
      "max_instances": 20, "instance_type": "standard" }
  ],
  "durable_objects": { "bindings": [
    { "name": "ACTIONS_RUN", "class_name": "ActionsRunCoordinator" },
    { "name": "ACTIONS_JOB", "class_name": "ActionsJobRunner" }
  ]},
  "migrations": [
    { "tag": "actions-v1",
      "new_sqlite_classes": ["ActionsRunCoordinator", "ActionsJobRunner"] }
  ],
  "queues": {
    "producers": [{ "queue": "takos-git-workflows", "binding": "WORKFLOW_QUEUE" }],
    "consumers": [{ "queue": "takos-git-workflows", "max_batch_size": 10,
                    "max_retries": 5, "dead_letter_queue": "takos-git-workflows-dlq" }]
  },
  "d1_databases": [{ "binding": "ACTIONS_DB", "database_name": "takos-git" }],
  "r2_buckets":   [{ "binding": "R2_ACTIONS", "bucket_name": "takos-git-actions" }]
}
```

**`main.tf` additions**, all `count = local.actions_enabled ? 1 : 0` (`var.enable_actions`, default `false`):

- `cloudflare_queue.workflows` + `cloudflare_queue.workflows_dlq` (+ consumer config with `dead_letter_queue`, `max_retries`).
- `cloudflare_d1_database.actions` (shared with collaboration-core D1) and a migrations-apply step.
- `cloudflare_r2_bucket.actions` = `${local.resource_prefix}-actions`, with a lifecycle rule expiring the `logs/` and `artifacts/` prefixes (e.g. 90 days) — git `BUCKET` keeps no lifecycle expiry.
- `cloudflare_containers_application` (or provider-current container resource) referencing the pushed image + `max_instances`/`instance_type`, plus the two DO namespaces.
- Extend the `cloudflare_workers_script.worker` `bindings` (`main.tf:319-372`) with: `d1` (`ACTIONS_DB`), `queue` (`WORKFLOW_QUEUE`), two `durable_object_namespace` bindings (`ACTIONS_RUN`, `ACTIONS_JOB` with `script_name` self-reference), `r2_bucket` (`R2_ACTIONS`), and `secret_text` (`ACTIONS_RUNNER_SECRET`, `ACTIONS_SECRETS_KEY`, generated `random_password`).
- New variable `enable_actions` and a `lifecycle.precondition` requiring `enable_actions` ⇒ `enable_cloudflare_worker_script` (container DOs must live in the same script) and a pushed image reference.
- Because the Worker now defines DO classes, the released bundle must export `ActionsRunCoordinator` and `ActionsJobRunner`; `worker_main_module` stays `worker.js`.

**Worker wiring:** add a `queue()` handler (consumer → `ACTIONS_RUN`), the `/internal/actions/{checkout,logs,artifacts}` routes guarded by the HMAC bearer, and the two exported DO classes. The event trigger that *creates* runs hangs off the existing receive-pack success path (push) and the PR merge/synchronize hooks from collaboration-core.

### 6. `uses:` handling (GHA-compat is a non-goal)

`uses:` is a **versioned capability set**, not a marketplace runtime. The container's `uses` handler resolves against a fixed allowlist of takos-git-native verbs and rejects everything else with a clear "unsupported action" conclusion (`skipped`/`failure` per policy). First-class set, in priority order:

1. `actions/checkout@*` → no-op alias (the repo is already checked out at the pinned commit); honors `with.ref`/`with.fetch-depth` by a scoped internal fetch only.
2. `actions/upload-artifact@*` / `actions/download-artifact@*` → the R2 artifact routes in §3.
3. `actions/cache@*` → keyed blob in `R2_ACTIONS` under `cache/<repoId>/<key>`.
4. `actions/setup-node@*` / `oven-sh/setup-bun@*` / `actions/setup-python@*` → select the pre-baked toolchain version in the image (no network install for the common case).

Everything else (`docker://…`, arbitrary `owner/repo@sha` JS/composite actions) is **unsupported in M3** and reported as such; a later milestone may add a sandboxed composite-action interpreter behind the same capability gate. This is honest under the "no GHA wire-compat" rule and avoids shipping `docker run` of untrusted third-party code inside the runner container. Workflow authors are steered toward `run:` steps, which cover the bulk of real pipelines.

### 7. Rewrite for `docs/collaborative-hosting.md`

Replace the M3 runner bullet (`docs/collaborative-hosting.md:95`) and align the Runtime-shape block. Concretely:

- **M3 bullet, replace line 95** with:

  > - **Self-hosted Actions runner (takos-git owns execution).** Workflow runs are dispatched inside takos-git's own Worker: a Queue tick → per-run coordinator Durable Object → per-job Cloudflare Container that checks out the pinned commit from takos-git's own Smart HTTP/R2 and runs the steps. The runner is **not** an external runner Interface, **not** a Takosumi `Runner`, and **not** the Takos agent. `uses:` is a versioned capability set, not GitHub Actions wire-compat. Enabled by `enable_actions` (Workers Paid + Containers); off by default keeps takos-git single-file and R2-only.

- **Runtime-shape block (lines 31-49):** under `Queue or Workflow (later milestone)` add `Actions dispatch → coordinator DO → runner Container`; under `R2` keep "Actions artifacts" but note a **separate `takos-git-actions` bucket** (logs + artifacts) distinct from the authoritative Git-object bucket; under `D1` add `workflow_run / workflow_job / check_run / actions_secret`.

- **Migration section, step 5 (line 121):** clarify that the Actions migration ports the pure `takos-actions-engine` and the step executor **into the container**, dropping the `RUNTIME_HOST` per-step network seam (which is a 503 stub in Takos today), and that the Takos `ai-review.ts` path is **not** migrated (agent-coupled).

- **"GitHub 互換にしない" paragraph (lines 107-108):** append that the Actions runner exposes `checks.v1` / `actions.v1` capability surfaces and a fixed embedded `ActionsRunnerProfile` (network/resource/secret policy modeled on Takosumi's `RunnerProfile`), and does not advertise GitHub Actions/REST compatibility.

---

I now have everything needed. Here is the spec section.

## Git primitives & Actions-engine port map

This section gives an exact, file-by-file migration map from the Takos product worker (`/root/dev/takos/takos`) into standalone `takos-git`. It honors the standing invariants: Git objects + refs stay authoritative in R2 (D1 never duplicates them), the per-repo refs-doc ETag CAS (`src/git/refs-store.ts:113`) remains the atomic receive-pack boundary, and the two auth planes stay unmixed. The no-legacy-shims rule applies: where `takos-git/src/git/` already has an implementation, we keep **one** and delete the other — no dual code paths.

The key structural fact driving Part A: **`takos-git/src/git/*` is the newer fork of the same lineage as the legacy Takos `local/core/*`.** The takos-git files carry "Lifted from the takos worker" / "Adapted from git-store" headers, use a narrow local `ObjectStoreBinding` (`src/git/types.ts:34`) instead of `shared/types/bindings.ts`, and are strict supersets (size caps, thin-pack resolution, path validation). So every overlapping primitive is **reconcile → keep takos-git, drop legacy**; only genuinely-absent primitives are **add-new**, and each add-new is ported R2-only with its D1 parameters removed.

### Part A — Git primitives

| Legacy source (`takos/src/worker/…`) | Decision | Target in `takos-git/src/git/` | Coupling to sever | Test to bring / rewrite |
|---|---|---|---|---|
| `application/services/takos-git/local/core/object.ts` (260) | **(b) reconcile → drop legacy** | keep `object.ts` (279) — canonical; adds `hashBlob/Tree/Commit` + strict header validation (`object.ts:176`) | none (pure); legacy import of `shared/types` not carried | keep `object.test.ts`; fold any roundtrip cases from `local/core/__tests__` |
| `local/core/object-store.ts` (240) | **(b) reconcile → drop legacy** | keep `object-store.ts` (285) — superset: `GitObjectTooLargeError`+maxBytes caps (`object-store.ts:33,190`), `getCompressedObject:265`, `putObject:179` | — | — |
| `local/core/pack-reader.ts` (390), `pack.ts` (80), `pack-common.ts` (121) | **(b) reconcile → drop legacy** | keep `pack-reader.ts` (399, thin-pack `resolveExternalBase`, delta-on-delta, cycle guard), `pack.ts`, `pack-common.ts`, `inflate-raw.ts` | — | keep existing pack tests |
| `local/core/tree-ops.ts` (297) | **(b) reconcile → drop legacy** | keep `tree-ops.ts` (313) — superset: `isValidGitPath`, path-scoped flatten cycle guard (`tree-ops.ts:252`), symlink handling | — | — |
| `local/core/sha1.ts` (36), `local/git-objects.ts` (122) | **(b) reconcile → drop legacy** | keep `sha1.ts` (45), `git-objects.ts` + `types.ts` | see D1-row-shaped types flag below | — |
| `local/core/merge.ts` — `mergeTrees3Way` (116) | **(a) add-new** | `src/git/merge.ts` | `ObjectStoreBinding` from `shared/types/bindings.ts:7` → local `./types.ts`; otherwise pure (uses `buildTreeFromPaths`+`flattenTree`, both present) | bring `local/core/__tests__` merge cases |
| `local/core/commit-index.ts` → `findMergeBase`/`isAncestor`/`countCommitsBetween`/`countCommitsTo` (`commit-index.ts:305–431`) | **(a) add-new, rewritten R2-only** | `src/git/merge-base.ts` | **drop `dbBinding`+`repoId` params and the `getCommit` D1 indirection**; read commits straight from R2 via `getCommitData` — `src/git/reachability.ts:50` already proves this exact pattern | new R2-only tests (legacy tests are D1-backed) |
| `local/core/commit-index.ts` → D1 index CRUD (`createCommit`/`indexCommit`/`getCommitFromIndex`/`getCommitsFromIndex`, `commit-index.ts:81–228`) | **(c) skip** — see D1 flag | — | — | — |
| `local/core/commit-index.ts` → `collectReachableObjects`/`collectReachableObjectShas` (`:437–565`) | **(c) skip** | already reimplemented R2-only at `src/git/reachability.ts:38` | — | (GC-over-all-refs variant deferred to M3) |
| `local/operations.ts` — `initRepository`/`commitFile`/`forkRepository`/`checkSyncStatus` (258) | **(a) add-new, reworked onto refs-store** | `src/git/operations.ts` (fork lineage → D1 metadata section) | replace `createBranch`/`getBranch`/`updateBranch` (D1 `core/refs.ts`) with `refs-store.ts` read/write + **ETag CAS**; drop `repoForks`/`repoRemotes`/`branches`/`tags` Drizzle tables | rewrite as R2-only lifecycle tests |
| `local/remote-fetch.ts` — `fetchRemoteRepository`/`ingestObjects` (294) | **(a) add-new, mostly verbatim** | `src/git/remote-fetch.ts` | `isPrivateIP` from `contracts/public/ip-classification.ts:16` → copy the small pure fn into takos-git; `ObjectStoreBinding` → `./types.ts`; `./core/*` → `./*` | bring loopback/thin-pack fetch test |
| `local/core/readable-commit.ts` — `resolveReadableCommitFromRef` (95) | **(a) add-new, reworked** (blame + Actions-blob prerequisite) | `src/git/resolve-ref.ts` | resolve ref via `refs-store.readRepoRefs` + `getCommitData` instead of D1 `resolveRef` | small resolver test |
| `shared/utils/lcs-diff.ts` (67) | **(a) add-new, verbatim** | `src/git/diff/lcs-diff.ts` | none (fully pure) | bring existing lcs tests |
| `shared/utils/unified-diff.ts` (151) — `buildHunks`/`formatUnifiedDiff`/`decodeBlobContent` | **(a) add-new, verbatim** | `src/git/diff/unified-diff.ts` | imports only `lcs-diff` | bring existing unified-diff tests |
| **tree-diff** (no module today; inlined in `server/routes/pull-requests/diff.ts:344–345` as `flattenTree(base)` vs `flattenTree(head)` path comparison) | **(a) add-new, extract pure module** | `src/git/tree-diff.ts` — `diffTrees(store, baseTreeSha, headTreeSha) → {path, status: added|modified|deleted}[]` over `flattenTree` (`tree-ops.ts:222`) | none; pure over already-ported `flattenTree` | new tests (feeds PR diff + commit diff) |
| **blame** — algorithm in `server/routes/repos/git-advanced.ts:515–604` (parent-walk + `diffLinesLcs` attribution) | **(a) add-new, extract pure core** | `src/git/blame.ts` — `blameFile(store, startCommitSha, path, limits) → lines[]` | strip the Hono handler (`git-advanced.ts:467`): `getCommit(DB,repoId,…)` → `getCommitData` (R2); `resolveReadableCommitFromRef` → `resolve-ref.ts`; `getBlobOidAtPath` → `tree-ops.getEntryAtPath` | new R2-only blame test; HTTP handler rebuilt in the hosting-API section |

**Flag — the commit-index D1 dependency (required call-out).** `commit-index.ts` and the D1 `commits` table (`infra/db/schema-repos.ts:97`) store `treeSha`/`parentShas`/author/committer/message — data that is **already the authoritative content of the R2 commit object**. Porting it would duplicate Git objects in D1, violating the standing invariant (`docs/collaborative-hosting.md:51–53`). Decision: **do not port the commit index into M2.** Every consumer of `getCommit(dbBinding, bucket, repoId, sha)` (log paging, merge-base, ancestry, blame) is re-pointed at `getCommitData(store, sha)` reading R2 directly, exactly as `reachability.ts` already does. The old cross-tenant security note (`commit-index.ts:239–245`, `refs.ts:544–556` — "a bare SHA must be validated against this repo's D1 index or it leaks another tenant's object") is satisfied structurally in takos-git instead: the object store is already repo-prefixed (`src/git/repo-object-store.ts:9` `git/v3/repos/<repo>/objects/…`), so a bare SHA can only resolve inside its own repo's prefix. **Document that prefix-scoping as the replacement isolation invariant.** If commit-log pagination ever needs an index for performance, rebuild it in M3 as an explicitly rebuildable cache keyed off refs — never as an authoritative store.

**Flag — D1-row-shaped types.** `git-objects.ts`/`types.ts:36–71` still carry `GitBranch`/`GitTag`/`GitCommitIndex`/`GitRepoFork`/`GitRepoRemote` (snake_case DB row shapes, e.g. `types.ts:36`). Keep only the pure value types (`GitCommit`/`TreeEntry`/`GitSignature`/`GitObjectType`/`FILE_MODES`). The row-shaped interfaces move to (and are owned by) the D1 metadata/ACL section; the git layer must not re-import them.

**Decoupling checklist (Part A).**
1. Every `import … from ".../shared/types/bindings.ts"` (`ObjectStoreBinding`, `SqlDatabaseBinding`) → local `./types.ts`; **`SqlDatabaseBinding` is deleted from the git layer entirely.**
2. Zero `drizzle-orm` / `infra/db` imports survive in `src/git/*`. The only persistence the git layer touches is R2 (loose objects + the per-repo refs doc).
3. Drop `repoId`+`dbBinding` from all walk/merge-base signatures; commits come from the repo-scoped R2 store (`repo-object-store.ts:21`).
4. All ref mutation goes through `refs-store.writeRepoRefs(…, expectedEtag)` (`refs-store.ts:113`) — the single atomic path. `operations.commitFile`/`initRepository` must use it, not a D1 branch update.
5. `mergeTrees3Way` stays path/OID/mode-level (`merge.ts:41`) — it returns conflicts but does **not** content-merge (no diff3). That is the intended model; content-merge is out of scope.

### Part B — Actions engine

Three concentric layers with three different fates: **(1) the planner is pure and ports verbatim; (2) the orchestration services + routes are D1/ACL-coupled and need rework; (3) the Cloudflare-Queue + `RUNTIME_HOST` execution fabric is dropped/replaced by the self-hosted Container+DO runner** that (per the DECISION RECORD) lives inside the takos-git worker. `ai-review.ts` is dropped.

| Legacy source | Class | Target in `takos-git/` | Coupling to sever | Test |
|---|---|---|---|---|
| `actions-engine/*` — `workflow-models.ts`, `parser/workflow.ts`, `parser/validator.ts`, `glob-match.ts`, `scheduler/{matrix,dependency,job-expansion,job}.ts`, `index.ts` | **pure-portable (verbatim)** | `src/actions/engine/*`, single re-export index | **none** — `index.ts:16–63` exports only types + `parseWorkflow`/`validateWorkflow`/`createExecutionPlan`/`globMatch`; no DB/bindings. Only change: consumers stop using the bare specifier `"takos-actions-engine"` and import the relative module | bring `actions-engine/__tests__/parser/*` + `__tests__/scheduler/*` verbatim |
| `application/services/actions/actions-execution.ts` — `createWorkflowJobs`/`enqueueFirstPhaseJobs`/`getWorkflowSecretIds` | **needs-rework** | `src/actions/runs/expansion.ts` | Drizzle `workflowJobs`/`workflowSteps`/`workflowSecrets` (`schema-workflows.ts:38,126,107`) → ported takos-git tables; `MessageQueueBinding` (`WORKFLOW_QUEUE`) dispatch → **self-hosted DO runner enqueue**; `toWorkflowJobDefinition` converter comes along | port expansion test, rebind queue mock to DO |
| `services/actions/actions-env.ts` — `buildWorkflowDispatchEnv` | **needs-rework (light)** | `src/actions/runs/env.ts` | strip Takos-specific values; keep the GitHub-style context env | bring env test |
| `services/actions/actions-triggers.ts` (20.5k) + `actions-trigger-cron.ts` + `actions-trigger-filters.ts` + `actions-trigger-workflow-loader.ts` | **needs-rework** | `src/actions/triggers/*` | push/PR/cron→workflow matching is valuable and mostly pure (uses engine `globMatch` + filters), but wired to the D1 workflow cache + `gitStore` + the Takos push path. Re-wire onto the takos-git receive-pack hook + `refs-store` + ported workflow tables | bring filter + cron tests |
| `services/workflow-runs/commands.ts` (14.5k) — run lifecycle | **needs-rework** | `src/actions/runs/commands.ts` | `gitStore.getBlobAtPath/getCommitData` → `src/git`; Drizzle `workflowRuns`/`workflows` → ported tables; `callRuntimeRequest` (`execution/runtime-request-handler`) → runner dispatch | rework run-create test |
| `services/workflow-runs/run-number.ts` | **portable (rebind handle only)** | `src/actions/runs/run-number.ts` | Drizzle table handle only; logic is pure derivation | bring run-number test |
| `services/workflow-runs/read-model.ts` + `stream.ts` | **needs-rework (read side)** | `src/actions/runs/read-model.ts` | rebind Drizzle run/job/step tables + log stream source | bring read-model test |
| `server/routes/repos/workflows.ts` (468) | **needs-rework** | `src/api/actions/workflows.ts` | `requireRepoRead/Write/Admin` (`git-shared.ts`, Space/account ACL) + `AuthenticatedRouteEnv` + Drizzle `workflows` → takos-git repo ACL + `/api/v1` contract | rebuild route test against `/api/v1` |
| `server/routes/repos/actions/{runs,jobs,logs,artifacts,secrets}.ts` | **needs-rework** | `src/api/actions/*` | `requireSpaceAccess`/`accountId` (present in `runs.ts`,`jobs.ts`,`artifacts.ts`) → takos-git ACL; `artifacts.ts` R2 store → takos-git R2 under an `actions/` prefix (runtime-shape doc already reserves it, `docs/collaborative-hosting.md:40`); `secrets.ts` → ported `workflowSecrets` + encryption | rebuild per-route tests |
| `runtime/queues/workflow-steps.ts:13–66` (`executeStep`→`RUNTIME_HOST`), `workflow-runtime-client.ts`, `workflow-jobs.ts`, `workflow-job-handler.ts`, `workflow-runner.ts`, `parallel-steps.ts`, `workflow-secrets.ts`, `workflow-events.ts`, `workflow-dlq.ts`, `workflow-types.ts` | **must-drop / replace** | — (replaced by the self-hosted runner section) | the Cloudflare-Queue + `RUNTIME_HOST` fabric. **Do not port** the RUNTIME_HOST client or the 503 stub `containers/runtime/src/runtime-service.ts`. **Hand the step contract to the runner section** (see below) | runner section owns exec tests |
| `runtime/queues/workflow-expressions.ts` + `workflow-job-phases.ts` | **salvage into runner** | runner-side orchestrator | runtime-agnostic: the `always()/success()/failure()/cancelled()` + limited `${{ }}` subset evaluator, and phase sequencing off `createExecutionPlan`. Port into the runner, not the worker | bring expression + phase tests into runner |
| `runtime/container-hosts/*`, `executor-*` | **skip/drop** | — | Takos agent-executor topology, not Actions | — |
| `application/services/pull-requests/ai-review.ts` | **must-drop** | — | agent/AI-Gateway coupled; its `flattenTree` helper (`ai-review.ts:35`) is redundant with ported `tree-ops` | — |

**The step-dispatch contract (hand to the runner section, do not drop it).** `RUNTIME_HOST` is replaced, but the *contract* it dispatched is the exact interface the self-hosted runner must implement. Request payload (`workflow-steps.ts:42–53`): `{ run, uses, with, env, name, shell, working-directory, continue-on-error, timeout-minutes }`, posted per job/step to `/actions/jobs/{jobId}/step/{stepNumber}`. Response (`RuntimeStepResponse`, consumed at `workflow-steps.ts:56–64`): `{ conclusion, exitCode, stdout, stderr, outputs }`. The new runner (Container+DO, mirroring `takosumi/worker/src/container_runner.ts` + `durable/OpenTofuRunnerObject.ts`, with a `RunnerProfile`-style network/resource/secret policy per `takosumi/contract/internal-deploy-control-api.ts:106`) must speak this shape so the ported orchestrator (`expansion.ts`/`commands.ts`) is unchanged above the dispatch seam.

**Decoupling checklist (Part B).**
1. **Planner is untouchable and shared** — port `actions-engine/*` byte-for-byte into `src/actions/engine`; the only edit is import specifiers. It has no couplings to sever.
2. **Replace `WORKFLOW_QUEUE` dispatch with the in-worker DO runner.** This diverges from the roadmap: `docs/collaborative-hosting.md:95` still says "runner Interface を使う Actions dispatch." The DECISION RECORD overrides it — **rewrite that M3 line** to state the runner is self-hosted inside takos-git (Container + Durable Object + `main.tf`), not an external runner Capsule.
3. **Replace `RUNTIME_HOST` + `runtime-service.ts` stub** with the runner container; preserve the step payload/response as the dispatch contract (above).
4. **Rebind all `workflow*` Drizzle tables** (`schema-workflows.ts:23–149`: `workflowArtifacts/Jobs/Runs/Secrets/Steps/workflows`) to takos-git-owned D1. Actions run/job/step/secret/artifact state is takos-git product state (`docs/collaborative-hosting.md:17`), never Takos-owned.
5. **Rebind all auth.** `requireRepoRead/Write/Admin`, `requireSpaceAccess`, `accountId` → takos-git repo ACL, authorized by browser OIDC session or a `source.git.hosting` Interface OAuth bearer. Never reuse the Takos `Space`/account FK.
6. **Drop `ai-review.ts` and any AI-Gateway/agent path** — explicitly out of scope for the standalone product.

**Migration-order fit.** Part A completes roadmap step 1 (`docs/collaborative-hosting.md:116`) — the object/tree/pack layer is already in `src/git`; this map adds the missing `merge` / `merge-base` / `tree-diff` / `diff` / `blame` / `resolve-ref` / `remote-fetch` / `operations` primitives, all R2-only. Part B is roadmap step 5 / milestone M3: the pure planner ports first (no risk), then the orchestration+routes reworked onto takos-git tables and ACL, and the execution fabric is handed to the self-hosted runner section rather than ported.

---

I have everything I need. Writing the spec section now.

## Feature port map (collaboration core)

This section maps every collaboration feature in `takos/src/worker/**` to a concrete target module in `takos-git`, the D1 tables it needs, the auth/role it requires, tests to port, and a reuse verdict. It is the detailed expansion of migration steps 2–5 in `docs/collaborative-hosting.md:116-121`.

### Reuse verdict legend

- **directly-portable** — pure logic over the object-store facade or over snake_case wire DTOs; copy with import-path rewrites only.
- **needs-rework** — real logic worth keeping, but it reads Git state from D1 (`branches`/`commits`/`tags`) or from the Takos `accounts` table, or dispatches Takos-only side effects; the algorithm survives, its I/O boundary is rewritten.
- **build-fresh** — no reusable implementation exists in `takos`; build against the new schema/ACL from the start.

### The one invariant that reshapes almost every port: refs live in R2, not D1

The legacy `takos` forge treats **D1 as the authoritative ref/commit store**. Merge, mergeability, PR listing, and fork-sync all resolve heads through `takosGit.resolveRef(env.DB, …)` / `getBranch(env.DB, …)` and advance branches with a D1 `UPDATE branches … WHERE commit_sha = <expected>` compare-and-swap (`pull-requests/merge.ts:194-224`, `services/pull-requests/merge-resolution.ts:500-535`). The `branches`/`commits`/`tags` tables (`infra/db/schema-repos.ts:45,97,445`) are that duplicate.

`takos-git` already made the opposite choice: the per-repo refs document in R2 is authoritative, and `writeRepoRefs(..., expectedEtag)` with `onlyIf.etagMatches` (`src/git/refs-store.ts:113-129`) is the atomic boundary that receive-pack already uses (`src/smart-http.ts:490-494`). **Therefore the `branches`, `commits`, `tags`, `blobs`, `chunks`, `files`, `snapshots` tables must NOT be ported.** Every ported feature that touches a head is reworked so that:

- read a head → `readRepoRefs` / `readRepoRefsSnapshot` (`src/git/refs-store.ts:60,67`) instead of a `branches`/`resolveRef` D1 read;
- advance a head → `readRepoRefsSnapshot` (capture `etag`) then `writeRepoRefs(..., snapshot.etag)`; the old D1 `WHERE commit_sha=expected` CAS becomes the ETag CAS. On ETag mismatch, return the same `409 REF_CONFLICT { current }` the merge code already returns (`pull-requests/merge.ts:158-163`).

This is the load-bearing rework for features (5)(7)(9)(12) and is why they are all **needs-rework** rather than directly-portable, even though the pure algorithms (3-way merge, LCS diff, merge-base) are directly-portable once the pure-Git section lands them in `src/git/`.

### Cross-cutting decoupling checklist (apply to every feature below)

Every ported file performs these four severs; per-feature sections only call out deviations.

1. **`accountId → accounts` FK ⟶ `principalId → principal`.** Legacy rows key ownership/authorship to the Takos `accounts` table (`schema-repos.ts:27,377`; `dto.ts:126-130` reads `accounts.name/picture`). `takos-git` has no accounts table. Introduce a local `principal` table (subject = OIDC `sub` for browser sessions, or the Interface-OAuth subject), populated first-seen from `/oauth/userinfo`, and rewrite `buildUserLiteMap` (`pull-requests/dto.ts:112-133`) to read it. Repository ownership becomes an `owner` string + owning-principal, not an `accounts.id`.
2. **Drop `requireSpaceAccess` / `checkSpaceAccess` / space-role model.** Legacy authorization is Space membership mapped to `owner/admin/editor/viewer` (`services/source/repos.ts:82-121`; `shared/constants/roles.ts:10-31`) via `requireSpaceAccess` (`repos/routes.ts:80`, `forks.ts:55,68`). Replace with the app-local **per-repo ACL** promised in `collaborative-hosting.md:68-70`: `resolveRepoRole(principal, repo) → owner | maintainer | writer | reader | none`, gated first by `repo.visibility` for anonymous/reader reads. The role tiers used at call sites translate: `["owner","admin","editor"]`/`WRITE_ROLES` → `writer+`; `ADMIN_ROLES` → `maintainer+`; `hasWriteRole(role)` → `role ≥ writer`.
3. **Drop `resolveOwnerUsername`** (`repos/repo-utils.ts:45`). It resolves `accounts.slug`; the new `owner` is a first-class column on the repository row, so this indirection disappears.
4. **Drop `shared/types` RPC imports.** Replace `AuthorType`, `PullRequestStatus`, `ReviewStatus`, `ReviewerType`, `SpaceRole`, `User`, `Repository`, `RepositoryVisibility` (imported in `dto.ts:1-6`, `reviews.ts:3-6`, `merge.ts:1`, etc.) with `takos-git`-local types. Keep the **snake_case DTO shapes** (`PullRequestDto`, `PullRequestReviewDto`, …) as-is — they are wire contracts, not RPC types, and are the `/api/v1` responses.
5. **Kill the `ai`/`agent` actor kinds.** `resolveActorLite` and `AI_USER_LITE`/`AGENT_USER_LITE` (`dto.ts:64-75,135-155`) and the `author_type` default `"agent"` (`schema-repos.ts:250`) are agent-coupled. Collapse to `human` (principal) and, for Interface-OAuth automation, `service_account`. This is the DTO-level counterpart to dropping `ai-review.ts`.
6. **Re-express Hono routers as `takos-git` dispatch.** `takos-git` has no framework — `handleForgeApi` is plain `(request, env) → Response` dispatch (`src/forge-api.ts:464-523`). Every `new Hono<AuthenticatedRouteEnv>().get(...)` router below is rewritten to that style (or a minimal internal matcher), with `zValidator` replaced by explicit body parsing.
7. **Turn Takos side-effects into local seams.** `createNotification` (`reviews.ts:196`, `comments.ts:119`), `triggerPrEvent`/`workflow-trigger.ts` (`pull-requests/routes.ts:98`), and `scheduleActionsAutoTrigger`/`triggerPushWorkflows` (`merge-handlers.ts:104-124`) all call Takos-worker services. In M2 they become a single local `emitRepoEvent(...)` seam that the webhooks (11), checks (11), and Actions (M3) features subscribe to; no Takos notification/agent dependency is carried over.

D1 table names below are **proposals to cross-check against the schema-design section**; where a legacy table maps cleanly I note it.

---

### (1) Repository metadata + visibility

- **Source:** `repos/routes.ts` (create `:64`, get `:192`, patch `:251`, delete `:324`), `repos/repo-utils.ts` (`formatRepositoryResponse:63`, cleanup `:104-181`).
- **Target:** `src/repos/metadata.ts` + write handlers behind `/api/v1/repos/:owner/:repo` (extends the existing read `repositoryInfo`, `src/forge-api.ts:213`).
- **D1 tables:** `repository` (from `schema-repos.ts:372`, minus the Git/social/marketplace columns — drop `stars`, `forks`, `install_count`, `featured`, `primary_language`, `remote_store_actor_url`; keep `id, owner, name, description, visibility, default_branch, forked_from_id, created_at, updated_at`; `git_enabled` becomes implicit). No `branches`/`commits`/`tags` tables.
- **Auth/role:** read = `reader` (or anonymous when `visibility=public`); create = `writer+` on the workspace; patch/delete = `maintainer+`.
- **Decoupling deltas beyond the checklist:** `POST /spaces/:spaceId/repos` (`:64`) loses the space path segment — repo identity is `owner/name` (matching `parseRepoRoute`, `src/forge-api.ts:125-149`), not `spaceId`. `default_branch` validation (`:283-296`) must switch from `gitStore.getBranch(DB,…)` to “branch exists in the R2 refs doc.” Delete (`:338-344`) currently cascades D1 `branches/repoForks/repoRemotes/workflowSecrets`; rewrite to delete the new collaboration rows + `deleteRepo` (`src/git/refs-store.ts:151`) + `deleteRepositoryObjects` (`src/git/repo-object-store.ts:74`); `collectCleanupCandidates`/`cleanupRepoGitObjects` (`repo-utils.ts:104-181`) can be dropped in favor of per-repo object prefixes (takos-git already isolates objects per repo).
- **Tests:** rewrite `repos/__tests__` create/patch/delete against R2 refs + D1 metadata; add visibility-gate tests (public anon read allowed, private anon 404).
- **Verdict:** **needs-rework** (metadata CRUD directly-portable; owner/space/branch-store coupling reworked).

### (2) Collaborators / teams

- **Source:** none (the space-role model stood in for this).
- **Target:** `src/repos/collaborators.ts`, `src/repos/teams.ts`, consumed by `src/acl.ts` (`resolveRepoRole`).
- **D1 tables:** `repo_collaborator(repo_id, principal_id, role)`, `team(id, workspace, slug, name)`, `team_member(team_id, principal_id)`, `repo_team(repo_id, team_id, role)`. Role enum = `reader|writer|maintainer|owner`. Effective role = max(owner-principal, direct collaborator, team grants).
- **Auth/role:** manage collaborators/teams = `maintainer+`; owner transfer = `owner`.
- **Decoupling:** this feature *is* the replacement for sever #2 — it is what `resolveRepoRole` reads instead of `checkSpaceAccess`. Browser principal = session `sub`; Interface-OAuth principal = bearer subject, and its effective role is additionally clamped by the token’s `source.git.hosting.*` scope (write scopes required before any `writer+` grant is honored, per `collaborative-hosting.md:62-64`).
- **Tests:** build-fresh unit tests for `resolveRepoRole` (visibility × collaborator × team × scope matrix); this is the security-critical core, test it exhaustively.
- **Verdict:** **build-fresh**.

### (3) Branch protection

- **Source:** the `branches.isProtected` boolean stub only (`schema-repos.ts:57`) — no enforcement logic exists.
- **Target:** `src/repos/branch-protection.ts`, enforced in the receive-pack path (`src/smart-http.ts`) and in the merge path (7).
- **D1 tables:** `branch_protection(repo_id, pattern, require_pr, required_approvals, require_status_checks JSON, allow_force_push, allow_deletions, restrict_pushers JSON)`. Keyed by branch-name glob, not by a per-branch row (there is no `branches` table).
- **Auth/role:** configure = `maintainer+`. Enforcement runs for every principal: it gates the R2 refs CAS write — a protected-branch push/merge that violates policy is rejected *before* `writeRepoRefs`.
- **Decoupling:** because there is no `branches` table, protection is evaluated at ref-update time against the R2 refs doc + required-check state (11) + required-approval count (6). Reuse the `require_status_checks`/`required_approvals` concepts from GitHub parity; there is no takos code to copy.
- **Tests:** build-fresh: force-push blocked, delete blocked, merge blocked until N approvals + green checks, glob matching.
- **Verdict:** **build-fresh** (stub → fresh).

### (4) Issues + comments + labels + milestones

- **Source:** none (`ABSENT everywhere` per the brief).
- **Target:** `src/issues/{routes,read-model,dto}.ts`.
- **D1 tables:** `issue(id, repo_id, number, title, body, state, author_principal_id, milestone_id, created_at, updated_at, closed_at)`, `issue_comment(id, issue_id, author_principal_id, body, created_at)`, `label(id, repo_id, name, color)`, `issue_label(issue_id, label_id)`, `milestone(id, repo_id, title, description, due_on, state)`. Reuse the **per-repo monotonic `number`** pattern from `getNextPullRequestNumber` (`read-model.ts:76-88`) and **share one number sequence with pull requests** (GitHub-parity: issues and PRs share the numbering space) — implement one `nextRepoItemNumber(repo_id)` used by both (4) and (5).
- **Auth/role:** open issue/comment = `reader+` (any authenticated principal on a readable repo, GitHub-parity for public repos); label/milestone management and issue close/reopen of others’ = `writer+`; author may close own.
- **Decoupling:** none legacy; apply checklist #1 (principal authorship), #4 (local types), #6 (dispatch), #7 (emit `issues`/`issue_comment` events for webhooks).
- **Tests:** build-fresh CRUD + state-transition + shared-numbering-with-PR tests.
- **Verdict:** **build-fresh**.

### (5) Pull requests: create / list / state

- **Source:** `pull-requests/routes.ts` (create `:41`, list `:127`, detail `:170`, diff `:207`, patch `:241`, close `:321`), `read-model.ts` (`findPullRequest:90`, `buildPullRequestList:108`, `buildPullRequestDetail:177`, `buildCommitMetrics:30`, `getNextPullRequestNumber:76`), `dto.ts` (`:20-250`), `diff.ts` (`:254,284`).
- **Target:** `src/pull-requests/{routes,read-model,dto,diff}.ts`.
- **D1 tables:** `pull_request` (from `schema-repos.ts:237`; keep `id, repo_id, number, title, description, head_branch, base_branch, status, author_principal_id, merged_at, timestamps`; drop `run_id`, replace `author_type/author_id` per checklist #1/#5). No `branches`/`commits` tables — heads resolve from R2.
- **Auth/role:** create/patch/close = `writer+` (legacy `["owner","admin","editor"]`, `routes.ts:57,256,326`); list/detail/diff = `reader`/anonymous-on-public (legacy `allowPublicRead`, `:148-154`).
- **Decoupling deltas:** `buildCommitMetrics` (`read-model.ts:30-74`) calls `resolveRef(DB,…)` + `countCommitsBetween(DB, bucket,…)` — rework both onto the R2 refs doc + the ported `countCommitsBetween` (pure-Git section). `dto.ts:126` `accounts` read → `principal` table. `triggerPrEvent` (`routes.ts:98,304,355`) → `emitRepoEvent` seam (checklist #7). `diff.ts` is the only nearly-clean file: `buildRepoDiffPayload`/`buildDetailedRepoDiffPayload` (`:254,284`) already run over the `takosGit` object-store facade via `flattenTree`/`getCommitData`/`diffLinesLcs` (`diff.ts:3,247-251`); only `resolveRef(env.DB,…)` (`:247,321-322`) is reworked to R2. `diffLinesLcs`/`decodeBlobContent` come from `shared/utils/lcs-diff.ts`+`unified-diff.ts` (ported by the pure-Git section into `src/git/`).
- **Tests:** port PR create/list/state tests from `pull-requests/__tests__`; rewrite the mergeability/commit-count assertions onto R2 refs; keep `diff.ts` snapshot tests (they are storage-agnostic).
- **Verdict:** **needs-rework** (`diff.ts` directly-portable; routes/read-model reworked for refs + principal).

### (6) Reviews + inline comments (DROP `ai-review.ts`)

- **Source:** `pull-requests/reviews.ts` (`POST reviews:125`, `GET reviews:231`) and `pull-requests/comments.ts` (`POST/GET comments:51,154`). **Do NOT port** `ai-review.ts` or the `POST …/ai-review` route (`reviews.ts:279-326`), and drop the `AiReviewError`/`runAiReview` imports (`:17-18`).
- **Target:** `src/pull-requests/{reviews,comments}.ts`.
- **D1 tables:** `pr_review` (from `schema-repos.ts:212`: `id, pr_id, principal_id, status(approved|changes_requested|commented), body, created_at`; drop `analysis` and `reviewer_type=ai`), `pr_review_comment`/`pr_comment` (from `schema-repos.ts:187`: `id, pr_id, principal_id, body, file_path, line_number, created_at`). The `analysis` column and `author_type` default `"ai"` (`:191,219`) are AI-review residue — omit.
- **Auth/role:** submit review/comment = `reader+` (GitHub allows any user with read to review; the enforced-approval count in branch protection (3) is where `writer+`/`CODEOWNERS` weighting would live). Legacy used plain `checkRepoAccess(...user.id)` with no role list (`reviews.ts:140`, `comments.ts:68`).
- **Decoupling deltas:** remove `createNotification` blocks (`reviews.ts:190-225`, `comments.ts:113-148`) → `emitRepoEvent` (checklist #7); collapse `toReviewerType`/`toAiReviewDto`/`toAiCommentDto` (`reviews.ts:41-122`) to the human/service-account path only.
- **Tests:** port review/comment happy-path + validation tests; **delete** ai-review tests; add “approval counts toward branch-protection gate” integration test bridging (3)+(6)+(7).
- **Verdict:** **needs-rework** (human review/comment logic directly-portable; AI path deleted, notifications reseamed).

### (7) Merge (`merge.ts`, `merge-handlers.ts`, `merge-resolution.ts` via `mergeTrees3Way`/`findMergeBase`)

- **Source:** `pull-requests/merge.ts` (`performPullRequestMerge:436`, `createRebaseMergeTarget:242`, `createMergeOrSquashTarget:345`, `advanceBaseBranchAndMarkPullRequestMerged:183`), `pull-requests/merge-handlers.ts` (`POST merge:40`, `GET conflicts:158`, `POST resolve:213`), `services/pull-requests/merge-resolution.ts` (`resolveConflictsAndMerge:123`, `checkConflicts:294`).
- **Target:** `src/pull-requests/merge.ts` + `src/pull-requests/merge-resolution.ts`.
- **D1 tables:** `pull_request` only (status→`merged`, `merged_at`). **No `branches` table** — this is the single biggest rework in the whole port.
- **Auth/role:** merge/resolve = `maintainer+` (legacy `["owner","admin"]`, `merge-handlers.ts:70,226`); conflicts read = `reader`.
- **Decoupling deltas (critical):**
  - The merge **algorithm** — `isAncestor`/fast-forward detection (`merge.ts:468,497`), `findMergeBase` (`:250,368`), `mergeTrees3Way` (`:308,393`), rebase replay + `createCommit` (`:298-340`), squash/merge-commit construction (`:418-431`), `buildMergedFileMap`/`buildTreeFromPaths` in resolution (`merge-resolution.ts:189-247,392-449`) — is all pure object-store work and is **directly-portable** once the pure-Git section provides `findMergeBase/isAncestor/countCommitsBetween/mergeTrees3Way/createCommit/buildTreeFromPaths` in `src/git/`.
  - The **head I/O** is reworked wholesale: `getBranch(DB,…)` (`merge.ts:451-460`, `merge-resolution.ts:137-146`) → `readRepoRefsSnapshot`; the D1 CAS in `advanceBaseBranchAndMarkPullRequestMerged` (`merge.ts:194-224`) and `advanceBaseBranchAndMarkMerged` (`merge-resolution.ts:500-535`) → `writeRepoRefs(..., snapshot.etag)` (`src/git/refs-store.ts:113`). The existing `409 REF_CONFLICT { current }` contract (`merge.ts:158-163`) is preserved but now sourced from ETag mismatch. **Branch advance + PR-status update are two stores (R2 then D1); the R2 ETag CAS is the commit point** — sequence R2 first, then D1 `status=merged`; on D1 failure the merge already landed, so make the PR-status update idempotent/retryable (roadmap `collaborative-hosting.md:52-53` “retryable state machine”).
  - `createCommit(DB, bucket, repoId, …)` (`merge.ts:325,418`) currently writes a `commits` D1 index row as a side effect — in `takos-git` it only `putCommit`s to R2; drop the D1 write.
  - `scheduleActionsAutoTrigger`/`triggerPushWorkflows` (`merge-handlers.ts:104-124`) → `emitRepoEvent("push", {before, after})` seam (checklist #7), consumed by checks/Actions in M3.
  - `checkConflicts` (`merge-resolution.ts:294`) reuses `getBlobAtPath` (already in `src/git/tree-ops.ts:126`) — directly-portable after the ref rework.
- **Tests:** port the merge/squash/rebase/conflict/resolve suites; add a **concurrent-merge ETag-CAS test** (two merges racing the same base → one 409) — this is the invariant that replaces the D1 CAS test and must not be lost.
- **Verdict:** **needs-rework** (algorithm directly-portable; ref store + commit indexing + event dispatch reworked).

### (8) Releases + assets + tags

- **Source:** `repos/release-crud.ts` (list `:27`, latest `:102`, get `:164`, create `:231`, patch `:319`, delete `:417`), `repos/release-assets.ts` (upload `:119`, download `:257`, delete `:321`, list `:371`).
- **Target:** `src/releases/{crud,assets}.ts`.
- **D1 tables:** `release` (from `schema-repos.ts:313`: keep `id, repo_id, tag, name, description, commit_sha, is_prerelease, is_draft, author_principal_id, published_at, timestamps`; drop `downloads`), `release_asset` (from `:289`: `id, release_id, asset_key, name, content_type, size_bytes, checksum_sha256`; drop `download_count`, `bundle_*` unless the artifact-manifest flow needs them). **Tags themselves are refs in the R2 refs doc, not a `tags` D1 table** — a release referencing `tag` reads/creates the tag ref via `refs-store`, and `release.commit_sha` is resolved from it.
- **Auth/role:** read incl. draft-visibility gate = `reader` public / drafts require `writer+` (legacy `hasWriteRole`, `release-crud.ts:38,183`); create/patch/delete + asset upload/delete = `writer+` (`:257,340,428`; `release-assets.ts:130,333`).
- **Decoupling deltas:** asset bytes already live in R2 via `c.env.GIT_OBJECTS` (`release-assets.ts:306,358`) → point at `takos-git`’s `BUCKET` under a `release-assets/<repo>/…` prefix (keeps the “Git objects + refs authoritative; assets are separate keys” invariant — assets are not Git objects). `accounts` author lookups (`release-crud.ts:64-71`) → `principal`. `invalidateCacheOnMutation`/`generateExploreInvalidationUrls` (`:233`) are Takos-explore concerns — drop.
- **Tests:** port release CRUD + draft-visibility + asset upload/download/checksum tests; rewrite author assertions onto `principal`.
- **Verdict:** **needs-rework** (release/asset logic directly-portable; author + tag-as-ref + asset-prefix reworked).

### (9) Fork + upstream sync

- **Source:** `services/source/fork.ts` (`forkWithWorkflows:46`, `syncWithUpstream:136`, `copyWorkflows:238`), `repos/forks.ts` (fork `:30`, delete-fork cleanup `:126`, list `:154`).
- **Target:** `src/forks.ts`.
- **D1 tables:** `repository` (new fork row + `forked_from_id`), `repo_fork` (from `schema-repos.ts:272`) or a `repo_upstream(repo_id, upstream_repo_id, remote_name, last_fetched_at)` table (merging `repo_forks`+`repo_remotes`, `:272,347`). Drop the D1 `stars/forks` counters (`fork.ts:102-104`) unless the metadata section keeps a social counter.
- **Auth/role:** fork = `reader` on source + `writer+` on target workspace (legacy `requireSpaceAccess` on both, `forks.ts:55,68`); sync = `writer+` on the fork.
- **Decoupling deltas:** `forkRepository(db, sourceId, forkId)` (`fork.ts:100`) currently copies the D1 `branches` rows and shares objects — rework to copy the **R2 refs doc** (`readRepoRefs`→`writeRepoRefs`, new-repo variant `onlyIf.etagDoesNotMatch:"*"`, `refs-store.ts:146`) and share/copy objects per takos-git’s per-repo object store. `syncWithUpstream` (`:136`): `checkSyncStatus`/`getBranch`/`updateBranch(DB,…)` (`:170,195-217`) → R2 refs read + ETag-CAS fast-forward; keep the fast-forward-only + conflict-report contract (`:177-193`). `copyWorkflows` (`:238`) depends on Actions — defer to M3 (make `copyWorkflows` a no-op seam in M2). `requireSpaceAccess` → per-repo/per-workspace ACL (checklist #2).
- **Tests:** port fork + fast-forward-sync + diverged-conflict tests; rewrite onto R2 refs; add a fork-then-race-sync ETag test.
- **Verdict:** **needs-rework**.

### (10) Webhooks

- **Source:** none.
- **Target:** `src/webhooks/{crud,delivery}.ts`, subscriber of the `emitRepoEvent` seam (checklist #7).
- **D1 tables:** `webhook(id, repo_id, url, secret_encrypted, events JSON, active, created_at)`, `webhook_delivery(id, webhook_id, event, payload, status_code, delivered_at, attempt, next_retry_at)`. Secret encryption uses a `takos-git` worker secret (not a Takos binding).
- **Auth/role:** manage = `maintainer+`; delivery is internal (no external auth). Roadmap places retryable delivery + audit in M3 (`collaborative-hosting.md:93`); M2 lands the CRUD + event model, M3 lands the retry queue.
- **Decoupling:** none legacy. Delivery needs an async mechanism — `takos-git` today has no Queue/DO binding (`main.tf` provisions only R2 + worker); this feature adds the first Queue/DO requirement and must be listed as a `main.tf` binding addition (coordinate with the runtime/infra section). Until then, `ctx.waitUntil` best-effort delivery is the M2 fallback.
- **Tests:** build-fresh: CRUD, HMAC signature, event filtering, retry/backoff (M3).
- **Verdict:** **build-fresh**.

### (11) Check runs + commit statuses

- **Source:** none (`check-run/commit-status API` absent).
- **Target:** `src/checks/{check-runs,statuses}.ts`.
- **D1 tables:** `check_run(id, repo_id, head_sha, name, status, conclusion, details_url, output JSON, started_at, completed_at)`, `commit_status(id, repo_id, sha, context, state(pending|success|failure|error), target_url, description, created_at)`. Keyed by **commit SHA** (from R2), never by a `commits` table row.
- **Auth/role:** create/update check/status = `writer+` or an Interface-OAuth service-account with a checks-write scope; read = `reader`. This is the surface Actions (M3) and branch protection (3) both consume (required-status gate).
- **Decoupling:** none legacy; the `workflow_runs`/`workflow_jobs`/`workflow_steps` tables (`schema-workflows.ts:38-146`) belong to the Actions section (M3), not here — checks are the parity-facing status API that Actions reports into.
- **Tests:** build-fresh: status rollup per SHA, check-run lifecycle, branch-protection required-checks integration.
- **Verdict:** **build-fresh**.

### (12) Code-browser read API

- **Source:** `repos/git-files.ts` (tree `:138`, blob `:140`, diff `:142`), `repos/git-commits.ts` (commit list/log `:307`, single commit `:66`, status `:263`), `repos/git-refs.ts` (branch list `:25`, tag list; plus branch create/delete/set-default writes `:149,214,240`), `repos/git-advanced.ts` (file history/log `:366,464`, blame `:467,617`). Semantic-search/semantic-index routes (`git-advanced.ts:265,295`) are **dropped** (Vectorize/index-job coupled).
- **Target:** extend `src/forge-api.ts` (the `/api/v1` read surface already implements repos/info/branches/commits/tree/blob, `src/forge-api.ts:464-523`) with new read actions, plus a small `src/read-api/blame.ts`.
- **What’s already done vs. to add:** `takos-git` already serves list/info/branches/commits/tree/blob directly over R2 (`forge-api.ts:213-462`). **Add:** single-commit detail, two-ref `compare`/`diff` (reuse `buildDetailedRepoDiffPayload`, feature 5 / `diff.ts:284`), **tag list** (from the R2 refs doc — `branchRecords`’s tag sibling, `forge-api.ts:229`), **file history/log** (`git-advanced.ts:366`, over `collectReachableObjects`, `src/git/reachability.ts:38`), and **blame** (`git-advanced.ts:467-618`).
- **D1 tables:** **none** — this surface is 100% R2 (Git objects + refs). This is the cleanest reinforcement of the “D1 must not duplicate Git objects” invariant.
- **Auth/role:** `reader`/anonymous-on-public, identical to the existing `authorizeRead` two-path model (browser session vs. `source.git.hosting.read` Interface OAuth, `forge-api.ts:74-110`). Branch create/delete/set-default (`git-refs.ts:149-275`) are **ref writes**, not reads — route them through the refs-store ETag CAS and gate at `writer+`; list them with feature (1) rather than the read API.
- **Decoupling deltas:** all four legacy files resolve through `resolveRef(env.DB,…)` and the D1 `branches`/`commits`/`tags` tables — every one is reworked to `readRepoRefs` + object-store walks. Blame and file-history reuse `getCommitData`/`flattenTree`/`getBlobAtPath` (already in `src/git/`) plus `diffLinesLcs` (pure-Git section). Keep the existing byte/limit guards (`MAX_BLOB_BYTES` etc., `forge-api.ts:32-35`).
- **Tests:** extend `src/forge-api.test.ts` with commit-detail, compare, tags, log, and blame cases over the existing R2 test bucket; assert the M1 “branch-name-only ref, no arbitrary SHA browse” rule (`collaborative-hosting.md:149-151`) still holds for the new endpoints.
- **Verdict:** **needs-rework** (read model directly-portable; D1 ref/commit reads reworked to R2; semantic-search dropped).

---

### Port order (aligns with `collaborative-hosting.md:116-121`, step 5)

1. **Pure-Git prerequisites** (other section): land `mergeTrees3Way`, `findMergeBase`/`isAncestor`/`countCommitsBetween`, `createCommit`, `buildTreeFromPaths`, `diffLinesLcs`/`decodeBlobContent` in `src/git/` over the object-store facade.
2. **ACL substrate** (2) + `principal` + `src/acl.ts` — nothing else can be authorized correctly until `resolveRepoRole` replaces `checkSpaceAccess`.
3. **Repository metadata + visibility** (1).
4. **PR create/list/state** (5) → **reviews/comments** (6) → **merge** (7) — the ref-CAS rework is concentrated here; write the concurrent-merge ETag test as the gate.
5. **Releases** (8) + **forks** (9).
6. **Issues/labels/milestones** (4) — independent, parallelizable with 4–5.
7. **Read-API extensions** (12) — incremental on the existing `forge-api.ts`.
8. **Branch protection** (3) + **webhooks** (10) + **checks** (11) — the enforcement/automation layer that also depends on the M3 Queue/DO binding addition to `main.tf`.

Throughout, the two `takos-git` invariants hold without exception: **Git objects + refs stay authoritative in R2 (no `branches`/`commits`/`tags`/`blobs`/`files` D1 tables)**, the **per-repo refs-doc ETag CAS is the atomic boundary for every head advance**, and the **browser-OIDC vs. Interface-OAuth auth paths stay unmixed** (`authorizeRead`, `src/forge-api.ts:74-110`).
