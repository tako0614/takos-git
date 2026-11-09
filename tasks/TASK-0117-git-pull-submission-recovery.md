---
task: TASK-0117
title: Recover original PR creation with a durable submission receipt
status: active
opened: 2026-11-09
branch: fix/TASK-0117-pr-conversation-recovery-20261109
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
submission and cross-device recovery remain outside this slice. The opened event is advisory, not crash-safe exactly-once
delivery. Keep these limits separate from duplicate-free committed creation.
Production STOP/control push HOLD remain in effect. Real DB/schema apply,
provider, credential, SSO, payment, Apply and deployment operations are outside
this unit. Preserve existing service/data and the ecosystem goal's unfinished
integration, normal-use, update/recovery and dedicated-App qualification.


## Follow-up: Issue and conversation-comment reload custody

The same writer reproduced two further actual built-SPA counterexamples on
current main: lost committed response, normal reload, same input with a new
key created Issue2 or comment2. Their new helper regressions were11 pass/4 fail.
Reuse the existing PR storage/recovery rather than independent implementations,
preserving its actual PR54 stored-wire fixture. Store original intent and newer
form separately; bind the actual caller/repository and comment's Issue ID.
Expose Issue.id from its actual row/existing receipt, without SQL/metadata
format changes. Bind comment-followed-by-close/reopen to the captured context
and suppress retired-response side effects. Old unbound API callers retain
compatibility; all existing role/scope/CSRF checks remain first.

During actual browser qualification, a deleted saved label remained hidden in
an otherwise retained newer draft and caused400. Show values absent from the
loaded choices with explicit removal, without inventing metadata or treating
list absence as global nonexistence. A separate comment reload hung because a
memoized recovery factory tracked its own restore signals. The bounded actual
Solid regression reproduced the recursive construction; untracked initial
restore fixes it without timers or automatic requests. The final built SPA
recovered both original identities, retained newer drafts/triage, refused an
actual second writer, and performed close only after the original caller's ACK.
Focused client40/224 assertions and backend42/271 pass. Final fixed-source
canonical/native/independent review and normal CI/integration are read separately.
No new schema/dependency, real input or deploy authority is included.

A further actual helper counterexample accepted a stored context.body field,
which could flow through object spreading into a state-only follow-up. Reject
unknown context fields and serialize only its three identifiers; preserve raw
corrupt markers before another POST. This is client/local source evidence, not
a live exploit or new authority. Backend/runtime inputs remain unchanged.

## Follow-up: PR conversation comment recovery

The separate PR conversation still sent unkeyed comments and cleared newer
input after any fulfilled response. Actual held201 cleared a newer draft;
socket loss after a committed201 appeared as empty200 to this browser ingress
and was accepted as success. Reload and a normal same-body send saved a second
comment, without a receipt. Preserve the distinct transport observations;
this unit does not diagnose or modify that ingress.

Reuse the existing Issue comment journal/recovery. Read DTOs project their
actual backing Issue ID; historical write-only creation metadata remains
byte-exact and may omit that field. Validate the submitted comment response
before retiring a pending key, isolate caller/repository/PR lifetimes, preserve
newer input and refresh the actual count. Current auth/CSRF/guard/SQL/schema and
all original receipts remain unchanged.

Actual built-SPA recovery retained one original comment after reload, rejected
another actual local writer with409/effect0, hid the original draft from that
writer and preserved a different PR's draft after a retired ACK. A separate
long-conversation RED hid the posted51st comment and had no cursor control.
Wire the existing opaque cursor to shared timeline append and keep confirmed
rows when an older page finishes. Final actual UI read53 unique comments,
retained the recovered pending draft and recovered a timed-out page by explicit
retry; a bounded in-flight-page/new-ACK case displayed52 unique rows.

Focused backend11/81 assertions and client2/78 assertions pass. One new actual
workerd/D1/R2 checkpoint confirms the read DTO's real Issue ID, same-key comment
replay and actual caller/other-PR/Repo409 effect0, with original metadata/FKs
preserved and outward HTTP0. Prior Issue/native cohorts are not rerun or
promoted. Fixed-source canonical, independent review and normal PR/CI/merge are
qualified separately. No real input, schema/dependency or deployment authority
is included; the original ecosystem goal remains incomplete.
