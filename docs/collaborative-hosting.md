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
- runner Interface を使う Actions dispatch。Takos agent implementation を埋め込まない
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
