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

# Workspace-less Interface follow-up

Both direct and portable modules now project the expected app_capsule_id without
requiring a Workspace. The v2.5 portable manifest declares noneditable install
context inputs too. Interface OAuth requires independently configured Capsule
identity (or exact legacy Workspace identity), exact audience/scope and complete Interface/Binding/revision evidence.
Workspace claims are optional even when compatibility configuration remains;
when supplied, they must be bounded and match configured legacy identity. No
human app_role is required for a machine capability. Missing both expected Capsule and legacy Workspace
fails closed. Direct and portable mock-provider plan tests plus Smart HTTP,
hosting API and MCP route tests cover Capsule-only mode and foreign-Capsule
rejection. The new verifier tests were RED (3 failures) before the fix; direct
OpenTofu Capsule-only browser setup also reproduced the two old precondition failures.


# Current Accounts compatibility and browser eligibility follow-up

Current Accounts emits `workspace_memberships` and nested `capsule_id`,
`workspace_id`, `role` (`owner/admin/member/viewer`), without `app_role`.
A matching configured Workspace retains its previous membership floor even when
Capsule evidence is present but the install has not received `APP_CAPSULE_ID`.
Configured Capsule/Workspace mismatches and malformed explicit roles fail closed.
With an exact configured Capsule and no app_role, fallback requires a matching
nested Workspace plus original membership or a validated legacy role.
Legacy owner/admin/member signals map to owner/member; legacy viewer membership
retains the old internal/create eligibility without a management-role signal.
Existing signed Workspace cookies retain only their previous membership floor
until expiry. New cookies revalidate role and membership through live UserInfo.

Internal reads and repository/fork/org creation now require app owner/member or
compatible Workspace membership. Public/private explicit ACL semantics and exact
scoped machine capabilities remain intact. Runtime evidence is threaded through
principals without persisted role columns, covering listings, code reads and
fork-network filtering. Direct and portable plans permit Workspace-only context
until the v2.5 install-context mapping is adopted.

Accounts access tokens currently last 300 seconds while app cookies can last
12 hours. On a rejected session, the server clears the cookie and returns
`session_expired`; the SPA starts OAuth login with the current return path. No
provider refresh-token contract, live sign-in, deployment, database or provider
mutation is introduced. Fifteen RED focused regressions preceded these fixes;
focused tests, static gates and the full CI check verify the final revision.
