---
task: TASK-0117
title: Recover original PR creation with a durable submission receipt
status: active
opened: 2026-11-09
branch: fix/TASK-0117-pr-creation-receipt-20261109
requiredFor:
  - persisted_schema
  - release_behavior
  - security_or_authority
repos:
  - takos-control
  - takos-git
grantsMutationAuthority: false
---

# TASK-0117: Durable PR creation recovery

This is the Git-owned source/local slice of the existing
`takos-control:tasks/TASK-0117-ecosystem-real-use-ux.md`, owned by the same
Sumi2 writer. It adds no task, writer or mutation authority and does not
complete the ecosystem goal. The user-facing operation is creating a PR,
losing the response, and explicitly recovering that original creation without
creating another PR or losing newer form edits.

## Persisted schema and compatibility

Migration `0007_pull_request_submissions.sql` additively introduces a receipt
scoped to repository, principal and submission-key hash. Applied migrations
`0001` through `0006` remain immutable. Number allocation, Issue, PR and the
optional receipt commit in one D1 batch. Same-key/same-normalized-intent retries
recover the original number; changed intent returns 409 without effects.
Individual PR/Issue deletion retains a tombstone receipt and returns typed 410
instead of resurrection. Repository/principal deletion cascades its receipts.

Keep the existing authorization and CSRF checks before receipt lookup. A
write-only caller recovers its original creation ACK without learning later
Git or profile changes; read-capable callers use the normal current read
projection. Store hashes rather than raw keys, and do not duplicate title/body
in the receipt. Existing unkeyed callers remain independent creations.

Old writers do not honor keys. Before enabling this behavior on a shared
runtime/database, make every writer receipt-aware; merely keeping old code
schema-compatible does not make mixed-writer recovery safe. Preserve receipts,
schema and migration-ledger rows and repair forward with receipt-aware code.
Do not delete or rewrite the migration ledger to downgrade. Owning rollout
conditions are in [deploy notes](../docs/deploy.md).
This source unit does not apply a migration to any real database.

## Source/local qualification

The previous actual API created two PRs for one principal/repository/key/input
and left an orphan Issue after a late PR insertion failure. New regressions
initially produced 1 pass/8 failures. Fixed API and migration tests pass 17
cases/106 assertions; the focused existing PR/Issue/comment cohort passes 57
cases/330 assertions. Client recovery passes 4 cases/28 assertions.

Actual local workerd D1/R2 passed seven checkpoints covering populated 0006
upgrade, concurrent same-key batches, conflict effect-zero, shared numbering,
committed-but-lost reply, late FK rollback/retry, scope isolation, original ACK
privacy, tombstones and cascades. Maximum SQL binds were 15; foreign keys stayed
on with no violations. Old migration hashes stayed unchanged.

The actual built SPA against the local router/auth/store passed lost-201
recovery through a temporary real ACL denial and restoration, same-number ACK,
newer edits, explicit fresh-key creation, deleted-receipt 410 and retired
cross-repository response. Initial identity/session and data are synthetic;
this is not real SSO, installed Host or live-service qualification.

The fixed functional tree `5b42ebb3131f1e04012a99e7b921ffe38dda5690` passed
`bun run check`: 604 backend tests/3282 assertions, 49 Web tests/216 assertions,
plus format, types, OpenTofu and builds. Source/dependencies/index, tested Web
assets and original migrations matched before/after. Required CI42668508274
also succeeded on that tree. This ledger-only review correction leaves every
previously qualified functional file unchanged; changed-head CI and independent
review are read separately before normal integration.

## Remaining boundaries

PR pending submissions now retain their original key/input and newer form in
this tab's sessionStorage across reload/route return, restoring as unknown with
explicit retry only. Stable repository ID and non-authorizing current sign-in
context constrain the journal and are verified server-side before replay/write.
The original actual built UI lost its key on reload and created PR2 from the
same intent. Fixed built UI recovered PR1 with one receipt/event, preserved
newer input, and created that new intent only with a fresh key. A real local
cookie switch to another synthetic caller was409/effect0; that caller's reload
showed none of the original recovery input, while the original caller recovered
PR1. Wrong canonical repository ID was409 with refs/counts unchanged.
Focused client15/80 assertions and backend78/250 assertions pass. Updated
fixed-source canonical, exact-head independent review and CI are qualified
separately. Prior successful SQL/native qualification is retained only for its
unchanged store/schema, not treated as proof of these new context guards.

Closing the tab/clearing storage loses custody; unsent drafts before a pending
submission, Issue/comment reload custody and cross-device recovery remain
outside this slice. The opened event is advisory, not crash-safe exactly-once
delivery. Keep these limits separate from duplicate-free committed creation.
Production STOP/control push HOLD remain in effect. Real DB/schema apply,
provider, credential, SSO, payment, Apply and deployment operations are outside
this unit. Preserve existing service/data and the ecosystem goal's unfinished
integration, normal-use, update/recovery and dedicated-App qualification.
