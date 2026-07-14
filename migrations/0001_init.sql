-- takos-git D1 metadata plane — baseline schema (migration 0001).
--
-- HARD INVARIANT: D1 holds relational METADATA ONLY. Git objects and refs stay
-- authoritative in R2 (objects under git/v3/repos/<repo>/objects/..., refs in the
-- per-repo document git/v2/refs/<repo>.json written with ETag CAS). Every column
-- below that carries a commit SHA, tree SHA, or ref tip (ref_index, commit_index,
-- git_tags, pr_commits, pull_requests.head_sha/base_sha/merge_base_sha,
-- releases.target_sha, check_runs.head_sha, commit_statuses.sha) is a DERIVED,
-- REBUILDABLE PROJECTION of R2. On any disagreement, R2 wins and the row is
-- recomputed by re-walking objects. No commit_sha-keyed table is a source of truth.
--
-- Conventions: TEXT ULID primary keys; INTEGER epoch-MILLISECONDS timestamps;
-- INTEGER 0/1 booleans; TEXT JSON blobs; child rows ON DELETE CASCADE from their
-- repo/owner/parent; principal references ON DELETE SET NULL so deleting a person
-- never destroys history.
--
-- Forward-only: this file is immutable once applied; additive changes ship as new
-- NNNN_*.sql migrations. Never rewrite an applied migration.

-- ============================================================================
-- 0. Schema migration ledger
-- ============================================================================
-- Records which migrations the Worker has applied. `ensureSchema` (src/db/
-- ensure-schema.ts) applies this baseline once per D1 database on first use, so a
-- Takosumi/OpenTofu install needs no separate `wrangler d1 migrations apply` step.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ============================================================================
-- 1. Identity and namespace
-- ============================================================================

-- A workspace-scoped actor. subject = OIDC sub or Interface OAuth sub.
CREATE TABLE IF NOT EXISTS principals (
  id             TEXT PRIMARY KEY,           -- ULID, internal stable id
  subject        TEXT NOT NULL,              -- OIDC sub (authoritative identity)
  kind           TEXT NOT NULL DEFAULT 'user', -- 'user' | 'service_account'
  display_name   TEXT,                       -- cached from userinfo, non-authoritative
  email          TEXT,                       -- cached, nullable
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_principals_subject ON principals(subject);

-- Namespace segment. Every repo lives under exactly one owner.
CREATE TABLE IF NOT EXISTS owners (
  id             TEXT PRIMARY KEY,
  login          TEXT NOT NULL,              -- URL segment, case-insensitive-unique
  type           TEXT NOT NULL,              -- 'user' | 'org'
  -- for type='user': the single backing principal; null for orgs
  principal_id   TEXT REFERENCES principals(id) ON DELETE SET NULL,
  display_name   TEXT,
  description    TEXT,
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owners_login ON owners(login COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_owners_principal ON owners(principal_id);

-- Org membership (only meaningful for type='org' owners).
CREATE TABLE IF NOT EXISTS org_memberships (
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (owner_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_org_memberships_principal ON org_memberships(principal_id);

-- ============================================================================
-- 2. Repositories
-- ============================================================================

CREATE TABLE IF NOT EXISTS repositories (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- The R2 path segment `<owner_login>/<name>` is derived; store it denormalized
  -- so refs-store / object-store lookups need no join.
  storage_key    TEXT NOT NULL,             -- e.g. "acme/web" -> git/v2/refs/acme/web.json
  description    TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private', -- 'public' | 'private' | 'internal'
  default_branch TEXT NOT NULL DEFAULT 'main',
  fork_of_id     TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  is_template    INTEGER NOT NULL DEFAULT 0,
  pushed_at      INTEGER,                   -- last successful receive-pack
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repositories_owner_name ON repositories(owner_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repositories_storage_key ON repositories(storage_key);
CREATE INDEX IF NOT EXISTS idx_repositories_visibility_updated ON repositories(visibility, updated_at);
CREATE INDEX IF NOT EXISTS idx_repositories_fork_of ON repositories(fork_of_id);

-- Per-repo monotonic sequence allocator. Issues and PRs SHARE one number
-- space (GitHub parity); run_number is per (repo, workflow_path).
CREATE TABLE IF NOT EXISTS repo_counters (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,             -- 'issue' (shared issue+PR) | 'workflow:<path>'
  next_value     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, scope)
);

-- ============================================================================
-- 3. Collaborators, teams, branch protection (real ACL)
-- ============================================================================

-- Direct per-repo role grant. role in owner|maintainer|writer|reader.
CREATE TABLE IF NOT EXISTS repo_collaborators (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,             -- 'owner'|'maintainer'|'writer'|'reader'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (repo_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_repo_collaborators_principal ON repo_collaborators(principal_id);

CREATE TABLE IF NOT EXISTS teams (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, -- must be type='org'
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_owner_slug ON teams(owner_id, slug COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS team_members (
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member', -- 'maintainer'|'member'
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_principal ON team_members(principal_id);

CREATE TABLE IF NOT EXISTS team_repo_access (
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,             -- maps to repo role vocabulary
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id)
);
CREATE INDEX IF NOT EXISTS idx_team_repo_access_repo ON team_repo_access(repo_id);

-- Branch protection. pattern is a fnmatch branch glob (e.g. "main", "release/*").
CREATE TABLE IF NOT EXISTS branch_protection_rules (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_protection_repo_pattern ON branch_protection_rules(repo_id, pattern);

-- ============================================================================
-- 4. Derived Git indexes (R2 projections, not sources of truth)
-- ============================================================================

-- Projection of the R2 refs-doc so branch/tag listing is one indexed scan.
CREATE TABLE IF NOT EXISTS ref_index (
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,             -- 'refs/heads/main', 'refs/tags/v1'
  kind           TEXT NOT NULL,             -- 'branch' | 'tag'
  target_sha     TEXT NOT NULL,             -- 40-hex, mirror of refs-doc
  is_default     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ref_index_repo_kind ON ref_index(repo_id, kind);
CREATE INDEX IF NOT EXISTS idx_ref_index_target ON ref_index(repo_id, target_sha);

-- Parsed commit headers so history/graph pages don't re-inflate packs.
CREATE TABLE IF NOT EXISTS commit_index (
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
CREATE INDEX IF NOT EXISTS idx_commit_index_repo_date ON commit_index(repo_id, commit_at);
CREATE INDEX IF NOT EXISTS idx_commit_index_tree ON commit_index(tree_sha);

-- Annotated-tag object metadata (lightweight tags need no row; ref_index covers them).
CREATE TABLE IF NOT EXISTS git_tags (
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

-- ============================================================================
-- 5. Issues, comments, labels, milestones
-- ============================================================================

CREATE TABLE IF NOT EXISTS milestones (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_milestones_repo_number ON milestones(repo_id, number);

CREATE TABLE IF NOT EXISTS labels (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL DEFAULT '888888', -- 6-hex, no '#'
  description    TEXT,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_labels_repo_name ON labels(repo_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS issues (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_issues_repo_number ON issues(repo_id, number);
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author_id);
CREATE INDEX IF NOT EXISTS idx_issues_milestone ON issues(milestone_id);

CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, principal_id)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id       TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label_id);

-- Conversation comments on issues AND pull requests (not inline code comments).
CREATE TABLE IF NOT EXISTS issue_comments (
  id             TEXT PRIMARY KEY,
  issue_id       TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at);

-- ============================================================================
-- 6. Pull requests, reviews, inline comments, PR commits
-- ============================================================================

CREATE TABLE IF NOT EXISTS pull_requests (
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
CREATE INDEX IF NOT EXISTS idx_pull_requests_repo ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_head ON pull_requests(head_repo_id, head_ref);

-- Ordered commits attributed to a PR (projection of the head..base walk).
CREATE TABLE IF NOT EXISTS pr_commits (
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  sha            TEXT NOT NULL,
  position       INTEGER NOT NULL,         -- order in the PR
  PRIMARY KEY (pr_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_pr_commits_pr_pos ON pr_commits(pr_id, position);

-- A submitted review verdict (approve/request-changes/comment).
CREATE TABLE IF NOT EXISTS pr_reviews (
  id             TEXT PRIMARY KEY,
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id    TEXT REFERENCES principals(id) ON DELETE SET NULL,
  state          TEXT NOT NULL,            -- 'approved'|'changes_requested'|'commented'|'pending'|'dismissed'
  body           TEXT,
  commit_sha     TEXT,                     -- head sha the review was made against
  submitted_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews(pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_reviewer ON pr_reviews(reviewer_id);

-- Inline code comments (file + line), optionally grouped under a review.
CREATE TABLE IF NOT EXISTS pr_review_comments (
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
CREATE INDEX IF NOT EXISTS idx_pr_review_comments_pr ON pr_review_comments(pr_id, file_path);
CREATE INDEX IF NOT EXISTS idx_pr_review_comments_review ON pr_review_comments(review_id);

-- ============================================================================
-- 7. Releases, assets, tags
-- ============================================================================

CREATE TABLE IF NOT EXISTS releases (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_releases_repo_tag ON releases(repo_id, tag_name);
CREATE INDEX IF NOT EXISTS idx_releases_repo_published ON releases(repo_id, published_at);

CREATE TABLE IF NOT EXISTS release_assets (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_release_assets_release_name ON release_assets(release_id, name);

-- ============================================================================
-- 8. Forks (network graph)
-- ============================================================================

CREATE TABLE IF NOT EXISTS repo_forks (
  id                TEXT PRIMARY KEY,
  fork_repo_id      TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
  upstream_repo_id  TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  -- external mirror source when the upstream is not a local repo
  upstream_url      TEXT,
  last_synced_at    INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repo_forks_upstream ON repo_forks(upstream_repo_id);

-- ============================================================================
-- 9. Webhooks and deliveries
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  content_type   TEXT NOT NULL DEFAULT 'application/json',
  secret_enc     TEXT,                     -- encrypted HMAC secret (see encryption note)
  events         TEXT NOT NULL,            -- JSON array: ['push','pull_request',...]
  active         INTEGER NOT NULL DEFAULT 1,
  ssl_verify     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_repo ON webhooks(repo_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
  claim_token    TEXT,                     -- owning queue/DO message id
  delivered_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);

-- ============================================================================
-- 10. Actions: workflows, runs, jobs, steps, artifacts, secrets
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflows_repo_path ON workflows(repo_id, path);

CREATE TABLE IF NOT EXISTS workflow_runs (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_runs_number
  ON workflow_runs(repo_id, workflow_path, run_number, run_attempt);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo_created ON workflow_runs(repo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_jobs (
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
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_run ON workflow_jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_status ON workflow_jobs(status);

CREATE TABLE IF NOT EXISTS workflow_steps (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_steps_job_number ON workflow_steps(job_id, number);

CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  r2_key         TEXT NOT NULL,            -- artifact bytes in R2
  size_bytes     INTEGER,
  content_type   TEXT,
  expires_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_artifacts_run ON workflow_run_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_artifacts_expires ON workflow_run_artifacts(expires_at);

-- Actions secrets: repo-scoped, encrypted at rest, injected into runner only.
CREATE TABLE IF NOT EXISTS workflow_secrets (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  value_enc      TEXT NOT NULL,            -- AES-GCM ciphertext; plaintext NEVER stored/logged
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_secrets_repo_name ON workflow_secrets(repo_id, name);

-- ============================================================================
-- 11. Check runs and commit statuses
-- ============================================================================

CREATE TABLE IF NOT EXISTS check_runs (
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
CREATE INDEX IF NOT EXISTS idx_check_runs_repo_sha ON check_runs(repo_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_check_runs_workflow_run ON check_runs(workflow_run_id);

CREATE TABLE IF NOT EXISTS commit_statuses (
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
CREATE INDEX IF NOT EXISTS idx_commit_statuses_repo_sha_ctx ON commit_statuses(repo_id, sha, context, created_at);
