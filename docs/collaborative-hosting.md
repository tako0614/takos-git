# Takos Git collaborative hosting

Takos Git は、単なる Git Smart HTTP endpoint ではなく、Workspace に install できる
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
  browser app
  hosting API
  Git Smart HTTP
  MCP repository lifecycle

R2
  repository-scoped Git objects
  release / LFS / Actions artifacts (later milestones)

D1 (next milestone)
  repository metadata / ACL
  Issue / pull request / review
  release / webhook / checks

Queue or Workflow (later milestone)
  indexing / webhook delivery / checks / Actions dispatch
```

現在の per-repository refs document と conditional R2 write は Git receive-pack の atomic
boundary として維持する。D1 を追加しても、Git object と ref の正本を暗黙に D1 へ二重化しない。
metadata operation と ref update をまたぐ処理は retryable state machine として明示する。

## Authentication and authorization

認証経路を混ぜない。

- Browser: Takosumi Accounts の authorization-code + PKCE。HttpOnly session cookie は
  install 先 `APP_WORKSPACE_ID` の membership を必須にする。
- Git CLI: `source.git.smart_http.read` / `source.git.smart_http.write` を持つ短命な
  Interface OAuth credential。
- Hosting API automation: `source.git.hosting.read` から始め、write permission は
  repository ACL と branch policy が実装されてから追加する。
- MCP: `mcp.invoke` Interface OAuth。明示された standalone bearer は direct/self-host
  deployment だけに使い、InterfaceBinding credential と呼ばない。

InterfaceBinding は service invocation を許可する。次 milestone で Takos Git の app-local
repository ACL が、その認可済み Principal を repository ごとに owner / maintainer / writer /
reader へ絞り込む。repository ごとに Takosumi Interface を量産しない。

## Product milestones

### M1: hosting shell

- standard clone / fetch / push
- Workspace-bound OIDC browser session
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

- webhook delivery with retry and audit evidence
- check run / status API
- **self-hosted Actions runner**: Actions の実行層は takos-git 自身の Worker に埋め込んだ
  Cloudflare Container + Durable Object。外部 runner Capsule でも Takos agent でもない
  (詳細は下記「Self-hosted Actions runner」)
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

## Self-hosted Actions runner

Actions の実行層は takos-git 自身の Worker に埋め込む。これは
[`github-parity-build.md`](github-parity-build.md) の Decision record の正本判断であり、旧稿の
「runner Interface を使う Actions dispatch」を **上書き** する。**外部 runner Capsule ではなく、
Takos agent でもない**。旧 Takos product 側の Actions 実行層 (`TakosRuntimeContainer` /
`RUNTIME_HOST` / `src/worker/runtime/queues/workflow-*`) は **retire** 済みで、この
self-hosted runner が唯一の後継。shim も dual path も Takos runtime への依存も持たない。

### 実行トポロジ

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
  `cancelRun`) だけを通し、二重 source of truth を作らない。再配送に対して idempotent。
- **Container DO (`ActionsJobRunner`)**: per-job で runner Container を起動し、job body を
  forward し、`ActionsJobResult` を coordinator に relay する。timeout / cancellation と
  RunnerProfile 相当の resource / network / secret policy (`default-deny` egress、bounded
  CPU/memory、runner-only secret、redacted log) を課す。
- **In-container executor** (`containers/runner/src/`): job body を受け取り、run-pin tree を
  checkout してから各 `StepExecContract` step を workspace で実行する。`shell` /
  `working-directory` / `env` / `continue-on-error` / `timeout-minutes` を尊重し、log を
  stream する。MVP の `uses:` は `checkout` と `upload-artifact` のみで、それ以外は `run:`
  shell。secret 値は run step の process env として注入し、全 log から **redact** する。

### R2 と run-pin

git data の正本は R2。run は作成時の commit を内部 ref `refs/takos-actions/<runId>` に
**pin** する (refs-doc と同じ ETag CAS 規律、`src/git/refs-store.ts`)。pin は git-visible な
refs doc の外に隔離した per-repo pin document (`git/v2/actions-pins/<repo>.json`) に置き、
smart-http では advertise されず client から push もできない。これにより run 実行中に
force-push が並行しても、runner が build する tree は動かない。log は
`R2_ACTIONS` の `logs/<repoId>/<runId>/<jobId>.log`、artifact は
`artifacts/<repoId>/<runId>/<name>` (+ `workflow_run_artifacts` 行) に seal する。

### Trust boundary

`/internal/actions/{checkout,logs,artifacts}` は Interface OAuth / browser session とは
**別の HMAC trust boundary**。container の callback は run 単位に mint した
`ACTIONS_RUNNER_SECRET` bearer (runId+jobId を bind) で認証する。fail-closed
(secret 未設定なら常に 401) で、router より前に dispatch し、`/api/v1` / `/git/` / `/mcp`
からは到達不能。checkout の repo / commit は token を信用せず runId から D1/R2 で解決する。

### Deploy (operator)

backing 資源 (Queue + DLQ、`ACTIONS_RUN` / `ACTIONS_JOB` DO namespace + `new_sqlite_classes`
migration、`R2_ACTIONS`、secret) は `enable_actions` gate 配下で `main.tf` が管理する
(default false で `tofu validate` / `plan` は zero resource)。runner Container image
(`containers/runner/Dockerfile`) だけは cloudflare provider 5.19.1 が表現できないため、
CI が image を build/push し、module output (`actions_runner_container`) を読む wrangler
`[[containers]]` step で `ActionsJobRunner` class に attach する (bundle / D1 migration と
同じ output-then-wrangler pattern)。

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
