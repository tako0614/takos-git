---
task: TASK-0117
title: Recover committed Git merge status without replaying Git writes
status: active
opened: 2026-11-09
branch: fix/TASK-0117-git-merge-metadata-20261109
requiredFor:
  - persisted_schema
  - release_behavior
  - security_or_authority
repos:
  - takos-control
  - takos-git
grantsMutationAuthority: false
---

# TASK-0117: Git merge status recovery

This is the Git-owned implementation slice of the existing
`takos-control:tasks/TASK-0117-ecosystem-real-use-ux.md`, owned by the same
Sumi2 writer. It does not create a new task or complete the ecosystem goal.
The user-facing path is merging a PR, observing a deferred metadata update,
reloading, and explicitly updating status without repeating the Git write.

## Scope and compatibility

- Keep Git objects/refs authoritative in R2 and current ACL/scope/CSRF checks.
- Commit an internal `pendingMerges` receipt in the same conditional R2 refs
  write as the merge action; atomically project both PR and Issue rows in D1.
- Return 202/`metadata_pending` on deferred projection. Restore pending state on
  reads and offer the existing SPA's explicit metadata-only reconcile action.
- Preserve the original commit, actor, method and time across later pushes,
  lost ACK and retry. Do not emit an old merge/push event again on reconcile.
- Keep normal ref writers compatible with retained receipts. Cleanup uses one
  fresh-snapshot CAS and retains the receipt on conflict/storage failure.

The persisted R2 format change is additive for new readers, but older writers
can discard it. Before activation, drain older runtimes that share this bucket;
before downgrade, reconcile pending receipts through the normal authorized
endpoint. Do not infer old failed operations without receipts from current ref
tips. The detailed format, bound and forward-repair procedure are in
[`docs/collaborative-hosting.md`](../docs/collaborative-hosting.md#committed-merge-status-recovery).
There is no D1 schema migration or destructive data repair in this slice.

## Qualification and remaining boundaries

The unchanged production route on isolated native local D1/R2 reproduced a 200
response with a merged PR and an open Issue. The same four checks passed after
repair. The expanded native cohort passed 83 checks: faults in either D1 update
for merge/squash/rebase/resolve, later actual receive-pack, original-commit
recovery, lost R2 ACK, concurrent merge CAS and cleanup failure; outbound HTTP 0.

The fixed functional source (`fbd3eb25b3adb75bdfbc8cab09b713b659af52bc`)
passed `bun run check`: root 523 tests/2570 assertions, Web 17/51, all format,
type, OpenTofu and build phases. Required CI run42557184706 also succeeded.
Actual built SPA in Chrome passed 10 checks covering pending state, reload,
failed status update, successful explicit recovery and terminal display. That
browser fixture uses local SQLite/memory R2 and synthetic session/interface
identity; the separate native cohort uses actual local D1/R2. Neither proves
real OAuth, installed Host, live service or provider qualification.

PR38's independent review requested this owning-repository task reference for
the persisted-format change. This task-only addition leaves the tested
functional source unchanged; updated exact-head CI/review and normal merge
remain to be read back. Crash-safe event delivery is a separate contract.
Production STOP/control push HOLD remain in effect. No provider, real DB,
credential, SSO, payment, Apply or deployment operation is authorized here.

## Follow-up: preserve the refs that passed merge protection

On 2026-11-09, the same writer reproduced a separate current-source race:
after the real required-status query succeeded for H1, a real branch update
advanced the head to unchecked H2, and the route merged H2 with HTTP 200.
The isolated native D1/R2 counterexample passed its two setup observations and
failed all four refusal/effect assertions. This is source/local evidence, not a
live exploit claim. The original six assertions pass after the minimal repair.

Pass the exact checked base/head tuple from the handler to both merge and
resolution algorithms, refuse a changed pair before computing a target, and
compare both refs again at the existing conditional-write boundary. Preserve
the original status/review/role policy, ETag CAS, durable receipt and metadata
recovery. Do not automatically replay a refused operation; a fresh explicit
request must evaluate the new head's real status. An unrelated tag update
before the CAS snapshot is read must be retained without invalidating the pair.

Dedicated regressions exercise all four methods, head/base changes at the
protection result, algorithm read and CAS snapshot, stable unchecked refusal,
valid checked success, unrelated ref preservation, and explicit recovery after
refusal. The first portable fixture supplied strings to a byte-only Git-tree
helper; its two accidental content conflicts are retained as fixture errors.
Correct byte input keeps the same refusal/effect oracles: 20 tests pass and 12
reproduce the race before the source repair. Updated full/native qualification,
independent exact-head review and normal integration are tracked with the same
TASK-0117, not a new task or mutation authority.
