---
task: TASK-0118
title: Accept per-app sign-in claims without widening Git repository ACLs
status: active
opened: 2026-10-28
branch: feature/TASK-0118-app-signin
requiredFor:
  - cross_repo
  - security_or_authority
repos:
  - takos-control
  - takosumi
  - takos
  - takos-git
  - takos-storage
  - takos-office
  - takos-computer
grantsMutationAuthority: false
---

# Scope and sequence

This repository implements TASK-0118 Phase 7, writer E. Takosumi Accounts owns
identity and app owner/member claims; takos-git consumes them after its shared
per-app contract and keeps repository authorization app-local. Other writers own
the Accounts issuer and the other installed apps. This branch changes only Git.

1. Inspect TASK-0117 open PRs, branch patch equivalence and clean worktrees before editing.
2. Accept all Accounts identities, require exact capsule context for app claims,
   and report only explicit owner/member management roles.
3. Revalidate current UserInfo on new session reads. Encrypt retained OAuth access
   tokens with AES-GCM and bind cookies to issuer/client/app context. Existing
   signed Workspace cookies remain ordinary identities until their existing expiry.
4. Preserve repository namespaces, collaborators, teams and visibility ACLs. An
   app management role does not grant ownership or maintenance of another repo.
5. Run focused regressions and touched static checks locally, then full CI.

# Installation and compatibility

TASK-0117 already delivered app_capsule_id beside app_workspace_id through the
repository manifest, OpenTofu inputs and APP_CAPSULE_ID plain-text binding.
BrowserAuthEnv now consumes that binding; existing Worker/router/MCP env types
already declared it. Legacy Workspace configuration and claims remain accepted.
No schema migration, credentials, database, deployment or live sign-in is involved.

# Validation

Focused browser-auth and repository sign-in regression tests cover any-account
admission, owner/member claims, foreign capsules, malformed roles, role removal,
revocation, subject changes, encrypted-cookie context, legacy sessions, and the
absence of repository permission escalation. Related router/ACL tests and worker
and web TypeScript checks run locally. Full `bun run check` runs in CI, per the
coordinator's explicit local-validation limit. This ledger does not authorize a
production mutation.
