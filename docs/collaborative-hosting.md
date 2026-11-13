# Takos Git collaborative hosting

Takos Git は、単なる Git Smart HTTP endpoint ではなく、独立したアプリとして install できる
standalone collaborative Git hosting product へ育てる。

標準 Git protocol はそのまま data plane として使う。Takosumi 専用 Git protocol や
repository manifest は作らない。Takosumi は Capsule の install / Run / Output / OIDC /
Interface / InterfaceBinding を管理し、repository・branch・Issue・pull request・review・
release・webhook・check の product state は Takos Git が所有する。

## Product boundary

| Concern                                                                   | Source owner      |
| ------------------------------------------------------------------------- | ----------------- |
| Git object / refs / clone / fetch / push                                  | `takos-git`       |
| Repository metadata / visibility / ACL / branch rules                     | `takos-git`       |
| Code browser / Issue / pull request / review / release / webhook / checks | `takos-git`       |
| Browser application and Git-hosting API                                   | `takos-git`       |
| Capsule install / plan / apply / state / Output / audit                   | Takosumi          |
| Human OIDC identity and short-lived Interface credentials                 | Takosumi Accounts |
| Takos chat / agent / memory / Workspace / app launcher                    | Takos             |

Takos は Takos Git の DB や R2 bucket を直接読まない。Takos Git を通常の Capsule として
install し、resolved Interface を通して利用する。Takos Git も Takosumi の repository や
dashboard 実装を import しない。

## Runtime shape

Cloudflare profile では次の構成を使う。

```text
Worker
  browser app (the built `web/` app, embedded in the Worker)
  hosting API (feature route registry)
  Git Smart HTTP (per-repository ACL when the metadata plane is enabled)
  MCP repository lifecycle

R2
  repository-scoped Git objects and refs
  Actions logs / artifacts (`R2_ACTIONS`, when Actions is enabled)

D1 (optional metadata plane, `enable_metadata`)
  repository metadata / ACL
  Issue / pull request / review
  release / webhook / checks

Queue + Durable Objects (Actions, `enable_actions`)
  workflow dispatch / run coordination / per-job runner dispatch
```

現在の per-repository refs document と conditional R2 write は Git receive-pack の atomic
boundary として維持する。D1 はすでに利用できる metadata plane だが、Git object と ref の正とする情報を
暗黙に D1 へ二重化しない。metadata operation と ref update をまたぐ処理は retryable state machine として
明示する。D1 を無効にした deploy は、per-repository ACL を適用せず scope-only の互換動作へ縮退する。

### Default branch settings and recovery

`PATCH /api/v1/repos/:owner/:repo` の `defaultBranch` は、現在の R2 refs document にある branch を選ぶ。
同じ refs ETag CAS で default HEAD を確定してから D1 の settings を反映するため、通常 clone、
ref 指定のないコード閲覧、repository detail/list が同じ既定 branch を使う。
存在しない branch は404 `branch_not_found`、CAS競合は409 `ref_update_conflict`とし、D1 settingsを変更しない。
repo.admin ACL、hosting.admin scope、browser CSRF は既存のまま適用する。

R2確定後のD1反映失敗は、確定したdefault branchとHTTP202 `metadata_pending: true`を返す。
既定branchの読取はR2を優先し、同じ明示PATCHでD1反映を再試行できる。R2のACK喪失は成功扱いにせず、
fresh GET/cloneで現在値を確認してから本人が再試行する。自動再送やrefのrollbackはしない。
後続writerが既定branchを変えた場合も、先の応答は自分のCASを表し、fresh GETは現在のR2値を返す。
通常pushで選択branchを削除した場合は、refs documentが選んだ残りの既定branchを読取へ反映する。
refを省略したActions discovery/dispatch、baseを省略した新規PR、branchを省略したfork syncも同じR2既定値を使う。
明示refと保存済みPR submissionのACKはその元の値を保ち、write-only ACK回復はR2再読取を前提にしない。
まだbranchのない空repoでは、読取DTOに作成時のconfigured default名を保つ。設定PATCHでbranchは作らない。
fork作成のACKは、その作成が確定したrefs receiptの既定branchを返し、作成後のR2再読取を前提にしない。
初回forkはsourceのrefs snapshotをobject copy前に一度読み、そのsnapshotのbranch/tagから到達するobjectだけを複製する。
コピー中にsource refsが変わっても、fork refsとD1 projectionは選択済みsnapshotを使い、後のsnapshotと混在させない。
sourceに残る未参照objectは複製せず、sourceのobjectやrefsは削除・変更しない。
fork一覧とnetworkは、閲覧を許可された各repositoryの現在のR2既定値を返す。後続writerが変更した場合は作成ACKとfresh読取が異なることがある。

### Upstream sync and concurrent pushes

forkの`POST /api/v1/repos/:owner/:repo/sync`はfast-forwardだけを受け付ける。
object copy中に対象branchが別writerによって更新・削除・作成された場合は、最初の判定に使ったSHAと
確定時のSHAを比較して409 `conflict`を返す。そのwriterのrefs／D1 projectionを上書きせず、sync eventも送らない。
現在のbranchを確認して明示再試行する。新しい履歴が分岐していれば409 `diverged`となり、自動force更新はしない。
対象外branchや既定branch名だけの変更は保持して同期できる。snapshot取得後の競合は既存ETag CASで拒否する。

### Committed merge status recovery

PR merge / squash / rebase / conflict resolution は、実行結果の commit・元 head/base・method・actor・時刻を
内部 refs document の `pendingMerges` に同じ R2 conditional write で保存する。D1 の PR/Issue 更新は
一つの atomic batch とし、失敗時は Git の変更を戻さず HTTP 202 と `metadata_pending: true` を返す。
通常の PR 読取にも `mergePending` を含め、reload 後も未反映を表示する。Web の **Update status** は
`POST /api/v1/repos/:owner/:repo/pulls/:number/reconcile` を呼ぶ。現在の `pulls.merge` ACL/scope/CSRF を
再確認し、保存済みの commit だけを D1 へ反映する。Git ref・object の再生成や merge/push event の
再送はしない。後続 push や force-push があっても、現在の tip を元の merge commit と取り違えない。

反映待ち中の base 変更・close/reopen は拒否する。状態更新後の receipt 削除は新しい refs snapshot に
対する一回の CAS とし、競合・storage 障害時は receipt を保持して警告する。DB 反映済みなら成功を
取り消さず、同じ status 更新で cleanup できる。未解消 receipt は最大128件、古い pending action を
自動廃棄しない。R2 ACK が失われた場合は失敗/不明として扱い、fresh PR GET で receipt を確認して
status 更新する。元の merge POST を自動再送しない。event の crash-safe/exactly-once 配送は別契約である。

この内部 R2 format は旧 document を読み続ける additive change だが、旧 writer は追加 field を保存しない。
有効化時は同じ bucket を更新する旧 runtime を先に drain し、全 writer が新 format を保持する状態で
使う。downgrade は pending receipt を正規経路で反映・解消してから行う。未解消 action があるまま
旧 runtime に戻して receipt を消す手順を rollback と呼ばない。既存の receipt がない過去の部分失敗を
現在の ref tip から推測して補完しない。source/local qualification は live rollout や旧データ修復の証明ではない。

merge／squash／rebase／resolveは、保護ルールを評価した時点のbase/head SHAを内部処理へ必須で渡す。
その後の読取でどちらかが変わっていたら409 `ref_conflict`とし、新しい未検査commitを取り込まない。
計算中にheadが進んだ場合も、refs documentのCASでbaseとheadの両方を比較し、古いheadだけを
マージしてPRを閉じない。現在のrole、required checks／reviews、CODEOWNERSなどの判定自体は維持する。
拒否後はreloadして新しいsnapshotを確認し、明示的に再試行する。新headのrequired checkがなければ
通常どおり拒否される。無関係なtagがCAS snapshotを読む前に追加された場合は、それを保持して処理できる。

競合解消は、明示された競合pathだけを解消し、それ以外は通常の3-way tree mergeと同じ規則で引き継ぐ。
merge baseと片側の両方にpathがない場合、その側は「変更なし」であり、反対側で追加したfileを消さない。
片側だけの追加、合意した追加、非競合の削除やfile mode変更も保持する。競合pathの未解決拒否と
明示的な削除／content解消は従来どおりで、textの自動diff3やrename推論を新たに導入しない。

## PR creation recovery

An optional `Idempotency-Key` binds a PR creation intent to the current
Repository/principal record. The shared number, Issue row, PR row and durable
receipt commit atomically. Retry the captured original key and payload after
an uncertain response; changed intent returns409 and a removed original410,
without allocating or resurrecting a PR. Unkeyed writes still create separate
PRs. Replay checks current authorization and does not repeat Git writes or
opened events. Event delivery remains advisory across a lost commit reply.

The receipt retains a creation projection from the actual original branch tips
and principal metadata, without another copy of its title/body or raw key. It
is a creation ACK, not the authority for current Git state. A write-only caller
cannot use it to read later owner edits, profile changes or activity; current
read authority still enables the ordinary R2-derived projection. Individual
PR deletion retains this tombstone; Repo/principal retirement cascades its scope.
The Web form keeps its original key/payload during explicit recovery and keeps
newer edits intact. Before dispatch, it stores the pending original key/input
and current form in this tab's `sessionStorage`. Reload or leaving and returning
to the route restores an unknown result; it never automatically posts. A
confirmed ACK or typed deletion clears only that attempt. Corrupt/unavailable
storage refuses a fresh submission rather than overwriting an uncertain one.
Closing the tab or clearing its storage loses this recovery; ordinary unsent
forms and cross-device recovery are not included.

`GET /api/auth/session` adds a non-authorizing `recoveryScope` digest of the
configured issuer/client/Capsule/Workspace context and current subject. No
cookie, bearer, client/session secret or profile is stored in the journal.
Repository DTOs include their stable metadata `id`. Journals are separated by
that ID and the caller context; a different caller or recreated path does not
recover another form's input. The captured `repository_id` and `recovery_scope`
are also sent with PR creation. After existing authentication/CSRF, the handler
checks both before receipt lookup or writes and returns409
`submission_context_changed` on mismatch. This also covers a cookie switch
after the page loaded. These optional checks grant no authority and leave old
unbound API callers compatible. Updated Web creation requires both server
metadata fields, so partial old-server rollout is visibly unavailable.

## Issue and comment recovery after reload

New Issue and Issue-conversation comment forms use the same write-ahead,
current-tab recovery as PR creation. They preserve the submitted key/input and
newer edits separately, restore unknown without automatic POST, and retain
uncertain originals on later authorization failures. Only a confirmed ACK,
authorized receipt tombstone, or the comment composer's existing explicit user
confirmation retires its local pending marker. A list match alone is not an ACK.
The persisted form contains user-entered content, not authentication material.

Issue creation retains labels, assignee subjects and milestone number as part
of its original intent; later edits do not mutate that snapshot. Saved choices
not present in the loaded options are displayed with explicit local removal,
not silently dropped or promoted into current metadata. This also lets a user
correct a newer draft after the original's triage references were removed.

Issue DTOs add stable `id`, including replay from an older receipt's existing
`issue_id`; no receipt format or database migration changes. Comment journals
are separated by caller context, repository ID and Issue ID. Optional captured
`repository_id`/`recovery_scope`/`issue_id` constraints are checked after existing
auth/CSRF and before Issue/comment replay or mutation. The same constraints bind
comment-followed-by-close/reopen. These remain separate authorized operations:
a comment ACK does not prove the later state change succeeded. Retired or
changed-context responses do not consume the current draft or perform a follow-up.

Saved comment context accepts only repository/caller/Issue identifiers. Request
serialization cannot spread stored context fields into comment content or the
state-only follow-up. Unexpected stored fields retain the raw marker and block
a fresh request rather than reinterpret that intent.

The shared recovery constructor does not track its own restore transitions
when created in a reactive memo. The pre-existing PR54 journal format remains
readable. Corrupt/unavailable storage holds the original instead of starting a
fresh operation; tab closure/clearing storage and unsent/cross-device drafts
remain outside the guarantee. A generic rejected retry still does not prove
that the original request rolled back.

## PR conversation comment recovery

PR conversations reuse the Issue comment journal and retained-key recovery.
Read projections expose the actual backing `issueId`; historical write-only PR
creation ACKs may omit it, without rewriting their retained creation metadata.
The current caller/repository/backing-Issue context constrains each comment.
An older server without this read field visibly disables the new composer
rather than sending an unbound comment.

Original submission and newer draft survive reload or leaving and returning to
the conversation in the same tab. No automatic POST occurs. Use **Retry original
comment…** to confirm recovery with the original key; a conversation list match
alone does not retire that intent. Empty success responses and replies missing
the submitted comment's ID/body/timestamps remain unknown. An uncertain
original is retired only by its matching sending attempt's confirmed response
or authorized tombstone.
Changed caller/PR and retired responses cannot clear the current draft.

Confirmed comments update the timeline and PR count without replacing the row
with the first page of an older conversation. **Load more comments** follows the
existing opaque API cursor, deduplicates acknowledged rows and retains a newer
ACK that arrives while an older page is pending. Failed page reads preserve the
loaded rows/cursor for explicit retry. This does not change server pagination,
review/merge authority or event-delivery guarantees. The same tab-storage and
unsent/cross-device limits described above apply.

## Authentication and authorization

認証経路を混ぜない。

- Browser: Takosumi Accounts の authorization-code + PKCE。どのアカウントでもログインできる。
  設定済み `APP_CAPSULE_ID` と完全一致する `takosumi.capsule_id` の `app_role: owner | member` を受け付ける。
  現在の Accounts は `app_role` をまだ返さず、`workspace_memberships` と
  `takosumi: { capsule_id, workspace_id, role }` を返すため、設定済み `APP_WORKSPACE_ID` に一致する
  参加証明を互換として維持する。設定済み Capsule に一致し `app_role` がない場合は、nested
  `workspace_id` の完全一致と元の `workspace_memberships` または有効な Workspace role の両方を要求する。Legacy Workspace の `owner/admin/member` は app `member` に対応し、Workspace role だけでは app owner に昇格しない。明示的な `app_role: owner` は引き続き app owner とする。`viewer` も従来の Workspace 参加者として internal 閲覧・作成の資格を維持する。
  明示された不正な role、設定済み Capsule または Workspace との実際の不一致は互換 claims があっても拒否する。
  `APP_CAPSULE_ID` が未配送の旧 install は、claim に Capsule が含まれていても Workspace の互換経路を使う。
  claim 自体から期待する Capsule を設定しない。
  `internal` repository の閲覧と repo/fork/org 作成は、アプリ owner/member または旧 Workspace 参加者に限る。
  public の匿名閲覧は維持し、private とその他の操作は namespace・collaborator・team の明示的 ACL で判定する。
  アプリ管理シグナルは他人の repository の owner/maintainer 権限を付与しない。

- TASK-0118 claim rollout: deploy the consuming apps first, then apply the
  Takosumi Accounts open-sign-in writer B change from PR #657 last. Self-host
  installs that have not received the app update must keep the configured
  `APP_WORKSPACE_ID` membership requirement until they update.
  新規セッションは access token を暗号化した HttpOnly cookie とし、毎回の session 読み取りで
  Accounts UserInfo の subject・アプリ・現在の role/参加状態を再検証する。権限を principal DB に保存しない。
  cookie の最大寿命は12時間だが Accounts access token は現在300秒で失効する。
  UserInfo が401になると cookie を消去し、SPA は現在のパスを return_to として OAuth login に進む。
  refresh token 契約は導入しておらず、失効後は Accounts のセッションで再認証する。
  無効な cookie を匿名へ降格させない。旧署名済み Workspace cookie は期限まで従来の参加資格を保持し、管理ロールは作らない。
- Git CLI: `source.git.smart_http.read` / `source.git.smart_http.write` を持つ短命な
  Interface OAuth credential。
- Hosting API automation: `source.git.hosting.read` から始め、write permission は
  repository ACL と branch policy が実装されてから追加する。
- MCP: `mcp.invoke` Interface OAuth。明示された standalone bearer は direct/self-host
  deployment だけに使い、InterfaceBinding credential と呼ばない。

InterfaceBinding は service invocation を許可する。Takos Git の app-local repository ACL は、
D1 が有効なとき、その認可済み Principal を repository ごとに owner / maintainer / writer / reader
へ絞り込む。repository ごとに Takosumi Interface を量産しない。

CollaboratorのpersonとInterface automationは、同subjectでも異なるPrincipalとして管理する。
一覧は従来のflat fieldsに加えてtyped `principal`と`bindingId`（personはnull）を返す。
ownerはPUTの`bindingId`で対象automationを指定でき、Webの設定画面もそのbindingを維持してroleを変更する。
DELETEは`?principalId=<一覧のprincipalId>`で一つのgrantへ限定できる。
selectorを省いた既存API呼出しは、指定subjectの全grantを削除する従来動作を維持する。
Webの削除は常に対象行のPrincipalを指定する。repo owner・scope・CSRFの判定は共通である。

Organization membershipもアプリ内で管理する。`GET /api/v1/orgs/:org/members`は現在のorg memberと
`source.git.hosting.read`を要求し、`limit`（1–100、既定100）・opaque `cursor`で一覧を返す。
`PUT /api/v1/orgs/:org/members/:subject`は現在のorg adminと`source.git.hosting.admin`を要求し、
bodyの`role: admin | member`と、automationの場合はexact `bindingId`を保存する。
`DELETE /api/v1/orgs/:org/members/:principalId`は一覧・PUTが返すPrincipal IDのmembershipだけを取り消す。
Browserは同じhandlerの既存session/CSRF検証を使い、他bindingのmembershipを推測しない。
書込みstatement内でcallerの現在のadmin資格と最後のadminを保護し、guardで拒否した既存rowを成功扱いしない。

通常のautomation導入は、org作成者がMCP bindingへ明示的なorg admin membershipを付与し、
MCPでorg内repoを作成後、Git bindingへそのrepoのwriter等を明示的に付与する。
API・MCP・Gitのbindingを同subjectだけで同一視しない。取り消しもそれぞれのmembership/grantを選択する。
Accounts roleやWorkspace参加をorg adminの代わりにしない。DBなしのscope-only Git/MCP互換は変更しない。

## Product milestones

### M1: hosting shell

- standard clone / fetch / push
- App-scoped OIDC browser session
- authenticated repository list / overview
- branch / recent commit / tree / blob read API
- browser consoleから上記 read API を確認できる

### M2: collaboration core

- D1 repository metadata, public/private visibility, collaborators, teams
- code browser UI, commit and diff pages
- Issue, comments, labels, milestones
- pull request, review, inline comment, conflict view, merge
- protected branch and required approval/check policy
- forks and releases

### M3: automation and large repositories

- durable R2-backed webhook delivery with a D1 audit/outbox log, leased
  retries, bounded exponential backoff, and a scheduled drain
- check run / status API
- **self-hosted Actions runner**: Actions の実行層は takos-git 自身の Worker に埋め込んだ
  Cloudflare Container + Durable Object。ソース実装はあるが、Worker bundle の
  `@cloudflare/containers` と out-of-band の `[[containers]]` image attachment が
  揃うまで実行可能な deploy にはならない (詳細は下記「Self-hosted Actions runner」)。
- Git LFS, release assets, import/mirror jobs
- asynchronous code index and search
- protocol v2 / shallow clone / partial clone の compatibility evidence

### M4: mature forge operation

- organization/team administration and audit log
- deploy keys / ServiceAccount automation after the workload-token contract is ready
- merge queue, rulesets, repository templates, archival and retention
- packages/pages は独立した標準 surface と owner が定義できた場合だけ追加する

GitHub REST/GraphQL API や GitHub Actions の完全互換は目標にしない。必要な integration は
versioned capability として追加し、未対応 API を GitHub 互換として広告しない。

### Browser diff contract

compare clientは既存Workerのtop-level `aheadBy`・`behindBy`・`files`を画面の件数・diffへ投影する。
diffのbaseは実handlerと同じ`mergeBaseSha ?? baseSha`を使い、merge baseを捏造しない。
`base...head`は一つのAPI route segmentへencodeし、`feature/topic`のようなbranch名も保持する。
元APIのstatus・認可・失敗応答とGit比較処理自体は変更しない。

Commit/compareとPR Filesの表示は、実Workerの`git/text-diff.ts`が返す
`content`・`oldLineNumber`・`newLineNumber`と`delete`種別を使う。
unified headerはhunkのold/new start・countから表示する。
PRの行コメントは削除行をLEFT/元行、追加・context行をRIGHT/新行へ固定し、
行番号が無い行にコメント先を推測して補わない。APIのschemaや認可を表示の都合で変更しない。

行コメントのACKも送信時の入力版だけを確認する。送信待ちに追記やedit/revertがあれば、
新しい本文とcomposerを残す。request先と行・commit・UI identityを捕捉し、退役やscope変更後の
応答で別の入力を消したり成功表示を出したりしない。未確認・不完全ACK・失敗では本文を残す。
このinline endpointには同key復旧receiptが無く、自動再送もしない。結果不明時はcomment一覧を
確認してから次の操作を決める。reloadを越えるinline draft保存は、この入力版保持の保証に含めない。

### Diff computation limits

Commit detail、compare、PR diff/files、blameはrequestごとにLCSのwork budgetを共有する。
全比較の`(oldLines + 1) * (newLines + 1)`の合計は4,000,000 cells以下、
比較に使うtextの入力合計は8 MiB・100,000行以下とする。bytesと行はfile間、
blameでは保持する変更version間で合算する。各積はsafe integerと上限を確認してから
DPを確保し、行配列も残り行数を確認してから作る。内部callerは上限を下げられるが、
HTTP queryや設定で上げる経路は設けない。

Fileの比較は逐次実行し、拒否後に後続fileを開始しない。各fileの両側blob読取りは並行だが、
同時に扱うのは一組だけとする。summaryは短い側の二行DPでexactな追加・削除数を計算し、
edit scriptやhunkを作らない。full diffとsummaryは同じ論理cell budgetを消費する。
Blameは変更versionのtext・行を保持する前にも上限を確認する。

Budget超過は部分的な成功や近似countにせず、既存error envelopeのHTTP 413で返す。
Commit/compare/PRは`diff_too_large`、blameは`blame_too_large`を使う。
既存の1 MiB/file、binary/oversizeのdiff placeholder、file数による`truncated`、
blameのfile/行上限による`blob_too_large`とhistoryの`truncated`は維持する。
このbudgetはtext alignmentを制限するもので、tree列挙・graph walk・conflict処理の
別の資源上限や、配信環境の性能を保証するものではない。

### Browser review submission

PRレビューのACKは、送信時の本文だけに適用する。送信待ちに追記・編集した本文があれば、
その入力とフォームを残したままレビュー一覧を更新する。本文が変わらなければ従来どおり閉じる。
画面移動で退役したフォームの遅いACK・失敗は、次の画面へ成功通知や状態更新を反映しない。
失敗した送信の自動再送は行わず、結果不明時はレビュー一覧で元の結果を確認する。

レビューの復旧は`POST /api/v1/repos/:owner/:repo/pulls/:number/reviews/submissions`と
元の`Idempotency-Key`を使う。旧Workerがキーを無視しないよう、旧`/reviews`へのfallbackはしない。
従来のキー無し`/reviews`は、独立した新しいレビューとして互換性を保つ。
browserは正規のrepository/Issue/sign-in contextで、送信前に元のverdict・本文・キーと現在入力を
端末のtab storageへ保存する。保存確認前はPOSTしない。未確認の元送信と待機中の追記は
reloadやConversation/Files間の移動後にも復元し、「Retry original review」でだけ照合する。
不完全なACK、保存/削除失敗、元結果が不明なままの拒否では、元の記録を捨てて別キーにしない。

DBの`0008`は旧migrationを変えず、reviewとそのreceiptを既存の
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)で一緒に確定する追加tableである。
receiptはIssue/principal/キーに拘束し、元PR・review・headを保持する。内容変更は409、
元reviewやPRが消えた場合は410で復活させない。replay時も現在の認可/contextを確認する。
移動したheadや閉じたPRへの復旧でも元のreviewだけを返し、再通知しない。通知は従来のbest-effort。
元ACK確認時に残る未送信の追記は、元キーを持たない別のdraftとして同じtab storageへ先に保存し、
その後で元intentの記録を退役させる。reloadやConversation/Files間の移動でも追記を復元し、
未確認の送信としては扱わない。追記の送信は別の明示操作と新しいキーを必要とする。
復元した追記の編集も保存し、明示的な空欄化や追記自体の確認済み送信で、そのdraftだけを消す。
caller/repository/Issueで保存先を分け、別フォームが更新した保存内容を古いACKで上書き・削除しない。
保存失敗では元intentを残し、同じキーで確認をやり直せる。初回送信前の通常draft全般、
tab closure/保存消去後や他端末からの回復、旧frontendへのrollbackはこの保証に含めない。

## Self-hosted Actions runner

Actions の実行層は takos-git 自身の Worker に埋め込む。Queue consumer、run coordinator DO、
job runner DO、in-container executor のソース実装は揃っているが、現在の deploy は runner
Container の起動条件を満たしていない。これは
[`github-parity-build.md`](github-parity-build.md) の Decision record を正とする判断であり、旧稿の
「runner Interface を使う Actions dispatch」を **上書き** する。**外部 runner Capsule ではなく、
Takos agent でもない**。旧 Takos product 側の Actions 実行層 (`TakosRuntimeContainer` /
`RUNTIME_HOST` / `src/worker/runtime/queues/workflow-*`) は **廃止** 済みで、この
self-hosted runner が唯一の後継。shim も dual path も Takos runtime への依存も持たない。
`main.tf` は `enable_actions` 配下の Queue/DO/R2 backing resources を管理するが、
`@cloudflare/containers` dependency と `[[containers]]` attachment が未適用のため、
現状では dispatch された job は実行に到達せず失敗する。

### 実行トポロジ (source implemented, container attachment blocked)

```text
receive-pack success
  └─ push-trigger → 5a control plane (parse → plan → persist → project)
       └─ WORKFLOW_QUEUE  { runId, repoId }
            └─ queue() consumer
                 └─ ACTIONS_RUN.idFromName(runId)   ActionsRunCoordinator (SQLite DO)
                      ├─ needs-DAG gate / skip 伝播 / concurrency budget / timeout alarm / cancel
                      └─ ACTIONS_JOB.idFromName(jobId)   ActionsJobRunner (Container DO)
                           └─ runner Container   in-container step executor
                                ├─ GET  /internal/actions/checkout   (run-pin tree を tar で取得)
                                ├─ POST /internal/actions/logs        (redacted log を R2_ACTIONS へ)
                                └─ POST /internal/actions/artifacts    (artifact を R2_ACTIONS へ)
```

- **Coordinator DO (`ActionsRunCoordinator`)**: run 単位の直列状態を持つ。5a が書いた
  `workflow_jobs` / `workflow_steps` を読み、`needs` DAG を評価して READY な job だけを
  Container DO に dispatch する。matrix job は job_key を共有し、集約 conclusion は最悪 cell。
  prerequisite が success 以外に settle したら dependent は skip。job timeout は alarm で
  reap。状態遷移は 5a callback (`startRun` / `startJob` / `updateStep` / `completeJob` /
  `cancelRun`) だけを通し、二重の正とする情報を作らない。再配送に対しても同じ結果になる。
- **Container DO (`ActionsJobRunner`)**: per-job で runner Container を起動し、job body を
  forward し、`ActionsJobResult` を coordinator に relay する。timeout / cancellation と、
  Worker が実際に適用する `RunnerPolicy` (concurrency、job/step timeout、log/artifact byte caps)
  を扱う。`RUNNER_CONTAINER_REQUIREMENTS` の `default-deny` egress と CPU/memory 値は
  container platform に渡す運用要件であり、takos-git の Worker は強制しない。attachment が
  未適用の現在は Container を起動できず、dispatch された job は失敗する。
- **In-container executor** (`containers/runner/src/`): job body を受け取り、run-pin tree を
  checkout してから各 `StepExecContract` step を workspace で実行する。`shell` /
  `working-directory` / `env` / `continue-on-error` / `timeout-minutes` を尊重し、log を
  stream する。現在の `uses:` は `checkout`、`upload-artifact`、`download-artifact` で、
  それ以外は `run:` shell。secret 値は run step の process env として注入し、全 log から
  **redact** する。

### R2 と run-pin

git data は R2 を正とする。run は作成時の commit を内部 ref `refs/takos-actions/<runId>` に
**pin** する (refs-doc と同じ ETag CAS 規律、`src/git/refs-store.ts`)。pin は git-visible な
refs doc の外に隔離した per-repo pin document (`git/v2/actions-pins/<repo>.json`) に置き、
smart-http では advertise されず client から push もできない。これにより run 実行中に
force-push が並行しても、runner が build する tree は動かない。log は
`R2_ACTIONS` の `logs/<repoId>/<runId>/<jobId>.log`、artifact は
`artifacts/<repoId>/<runId>/<name>` (+ `workflow_run_artifacts` 行) に seal する。

### Trust boundary

`/internal/actions/{checkout,logs,artifacts}` は Interface OAuth / browser session とは
**別の HMAC trust boundary**。container の callback は run 単位に mint した
`ACTIONS_RUNNER_SECRET` bearer (runId+jobId を bind) で認証する。安全側に停止
(secret 未設定なら常に 401) で、router より前に dispatch し、`/api/v1` / `/git/` / `/mcp`
からは到達不能。checkout の repo / commit は token を信用せず runId から D1/R2 で解決する。

### Deploy (operator)

backing 資源 (Queue + DLQ、`ACTIONS_RUN` / `ACTIONS_JOB` DO namespace + `new_sqlite_classes`
migration、`R2_ACTIONS`、secret) は `enable_actions` gate 配下で `main.tf` が管理する
(default false で `tofu validate` / `plan` は zero resource)。runner Container image
(`containers/runner/Dockerfile`) だけは cloudflare provider 5.19.1 が表現できないため、
CI/operator が image を build/push し、module output (`actions_runner_container`) を読む
wrangler `[[containers]]` step で `ActionsJobRunner` class に attach する。現在は Worker bundle
に `@cloudflare/containers` がなく attachment も未適用なので、この out-of-band step が完了する
まで Actions execution は blocked のままである。

### Follow-ups (documented, out of MVP)

live-tail WebSocket log、`setup-*` / cache などの action、cross-run の `concurrency:`
supersede、runner autoscaling、native git-clone credential helper 経由の checkout。

## Migration from Takos

Takos worker には、historical implementation として code browser、branch、fork、release、
pull request、review、merge、Actions の code が残っている。これを runtime dependency にせず、
次の順番で standalone Takos Git へ移す。

1. Pure Git object / tree / merge codeを `src/git/` に移し、R2-only tests を先に通す。
2. `Space` / Takos account table に依存する repository metadata を、Takos Git の
   Workspace-scoped Principal/ACL model に置き換える。
3. Route contract を `takos-git` の `/api/v1` として固定し、Takos 固有 RPC typeを持ち込まない。
4. Repo UI componentを Takos shell / chat navigation / global storeから切り離して移す。
5. PR/review/merge、release、Actions の順に移し、各 surface の E2E parity を作る。
6. Takos は resolved Interface consumer に切り替え、parity 後に Takos 内の duplicate Git
   hosting implementation を削除する。

移行中も source owner は `takos-git`。Takos 内の旧実装へ新機能を追加してからコピーする流れには戻さない。

## M1 HTTP contract

Browser auth:

```http
GET  /api/auth/login
GET  /api/auth/callback
GET  /api/auth/session
POST /api/auth/logout
```

Authenticated hosting read API:

```http
GET /api/v1/repos
GET /api/v1/repos/:owner/:repo
GET /api/v1/repos/:owner/:repo/branches
GET /api/v1/repos/:owner/:repo/commits?ref=main&limit=30
GET /api/v1/repos/:owner/:repo/tree?ref=main&path=src
GET /api/v1/repos/:owner/:repo/blob?ref=main&path=README.md
```

M1 browse ref は branch name のみ受け付ける。arbitrary SHA を直接解決しないため、拒否された
push が残した dangling object を SHA 推測で閲覧できない。blob response は 1 MiB までで、
UTF-8 または base64 encoding を明示する。


### Review target and original receipt recovery

A new review or inline diff comment must send the exact displayed `commitSha`.
The Worker compares it with the current R2-authoritative PR head before inserting
anything, and refuses a missing/malformed target or a changed head. The diff
composer takes this value from its diff response, not a separately loaded PR.
A review form retains the head it was opened against; changing the head requires
checking the new version before opening another review.

Existing keyed receipts are read before the open/head checks. Retrying the
original payload returns its original review and commit even after the branch
moves or the PR closes. A key cannot be rebound to another commit. Old journals
without a commit may recover a committed receipt, but cannot create a new
review. Closed PR pages expose recovery while disabling new review submissions.
The newer unsent draft and uncertain original remain separate.

Browser comparison links decode their route spec once before passing literal
refs to the API, which encodes them as one segment. This preserves slash and
percent characters without double encoding.
