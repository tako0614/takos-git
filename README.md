# takos-git

English: [README.en.md](README.en.md)

takos-git は、標準の `git clone` / `fetch` / `push` がそのまま使える、独立した
collaborative Git hosting product です。R2 object store を Git data plane として使い、
Workspace-bound な browser、hosting API、リポジトリ管理用 MCP server を公開します。

実体は plain な OpenTofu module + ビルド済み Cloudflare Worker で、ほかの
Capsule (Git URL から取り込む 1 つのアプリ/インフラ単位) と同じように Takosumi から
インストールします。Takos worker の内部サービスではありません。product 固有の workspace
filesystem サービスとは別の通常の installable product です。公開する service surface は
`storage.object` とは別の `source.git.smart_http`、`source.git.hosting` と、リポジトリの
ライフサイクル操作用の `mcp.server` です。

GitHub 的な共同作業機能へ広げる source-owner 境界と移行順は
[`docs/collaborative-hosting.md`](docs/collaborative-hosting.md) が正本です。

## できること

- アプリ所有の R2 bucket の上で Git Smart HTTP を提供します。object は content-addressed な
  loose object として保存され、各リポジトリの refs は 1 つの JSON document です
- Git Smart HTTP は短命な `taksrv_` Interface OAuth credential を使います。
  clone/fetch は `source.git.smart_http.read`、push は
  `source.git.smart_http.write` を要求します
- receive-pack では pack/checksum/delta の検証・object closure の確認・リクエスト単位の
  atomic な ref 差し替えを行い、通常ブランチの更新は fast-forward のみ受け付けます
- 依存ライブラリなしの Streamable HTTP MCP endpoint を持ちます。ツールは
  `git_repo_list` / `git_repo_create` / `git_repo_info` / `git_repo_delete` のちょうど 4 つです
- Takosumi Accounts の authorization-code + PKCE で browser session を作り、install 先
  Workspace の membership を検証します
- `/api/v1` で repository list / overview / branch / commit / tree / blob を読み、`/` と `/ui`
  の browser console から確認できます

clone / commit / fetch / push は意図的に独自の MCP ツールにしていません。agent は
インストール済みの computer/sandbox Capsule と通常の Git CLI を、呼び出し時だけ発行される
Interface credential と一緒に使います。

## 始め方 (OpenTofu で deploy)

module は Cloudflare の feature flag を有効にするまでリソースを作りません。

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var cloudflare_account_id=<id> \
  -var public_url=https://git.example \
  -var takosumi_accounts_issuer_url=https://accounts.example \
  -var 'env={APP_WORKSPACE_ID="<workspace-id>",APP_CAPSULE_ID="<capsule-id>"}'
```

`public_url` と `takosumi_accounts_issuer_url` は path / query / fragment / userinfo を持たない HTTPS origin を指定します（末尾 `/` は正規化されます）。

hosted 環境からのインストールでは、Git release や CI artifact の
`worker_bundle_url` + `worker_bundle_sha256` を読み込みます。`dist/worker.js` は commit しません。

## 仕組み

### HTTP surface

| Method | Path                                                 | Permission                                   | Notes                          |
| ------ | ---------------------------------------------------- | -------------------------------------------- | ------------------------------ |
| GET    | `/healthz`                                           | —                                            | 死活確認                       |
| GET    | `/`, `/ui`                                           | —                                            | ブラウザコンソール             |
| GET    | `/api/auth/login`, `/api/auth/callback`              | OIDC                                         | browser sign-in                |
| GET    | `/api/auth/session`                                  | cookie                                       | browser session state          |
| POST   | `/api/auth/logout`                                   | cookie                                       | browser sign-out               |
| GET    | `/api/v1/repos/...`                                  | browser session or `source.git.hosting.read` | repository/code browser        |
| GET    | `/git/<repo>.git/info/refs?service=git-upload-pack`  | `source.git.smart_http.read`                 | clone/fetch advertisement      |
| POST   | `/git/<repo>.git/git-upload-pack`                    | `source.git.smart_http.read`                 | clone/fetch packfile           |
| GET    | `/git/<repo>.git/info/refs?service=git-receive-pack` | `source.git.smart_http.write`                | push advertisement             |
| POST   | `/git/<repo>.git/git-receive-pack`                   | `source.git.smart_http.write`                | 検証付き push                  |
| POST   | `/mcp`                                               | `mcp.invoke`                                 | リポジトリのライフサイクル MCP |

Takosumi-managed な Git/hosting/MCP 呼び出しは、通常の `api_url` / `hosting_api_url` /
`mcp_url` Output を resource URI に
明示 mapping した service-side Interface と InterfaceBinding を使います。Interface/blueprint は上記
permission を明示します。Accounts は UserInfo が token を active と返す前に current Core の
Interface / Binding state を再検証し、Worker は audience、scope、Workspace、Capsule、subject と
完全な Interface / Binding evidence shape を fail-closed 検証します。Interface id / resolved revision
は static module input や Worker env にせず、apply 後に materialize する Interface を初回 apply 前に
要求する循環を作りません。managed InstallConfig は通常の `env` input 経由で `APP_WORKSPACE_ID` と
`APP_CAPSULE_ID` を渡します。宣言・credential は Output に入れません。

`PUBLISHED_MCP_AUTH_TOKEN` は直接/self-host deployment 用の standalone MCP bearer としてだけ残し、
InterfaceBinding delivery とは扱いません。値は output しません。

service-side `interfaceBlueprints` が宣言する surface は次の通りです (binding の subject は install 後に選択します)。

| Interface type          | Resource URI input | Supported InterfaceBinding permissions                      |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| `source.git.smart_http` | `api_url`          | `source.git.smart_http.read`, `source.git.smart_http.write` |
| `source.git.hosting`    | `hosting_api_url`  | `source.git.hosting.read`                                   |
| `mcp.server`            | `mcp_url`          | `mcp.invoke`                                                |

browser sign-in を有効にする場合は `takosumi_accounts_issuer_url`、
`takosumi_accounts_client_id`、32 文字以上の `app_session_secret` を一緒に渡します。
confidential client なら `takosumi_accounts_client_secret` も secret input として渡します。
managed InstallConfig は `env.APP_WORKSPACE_ID` / `env.APP_CAPSULE_ID` も明示します。secret は
repo や Output に書きません。

### 削除と後片付け

リポジトリの object はリポジトリ所有の object prefix の下に分離されているため、通常の
リポジトリ削除 API でそのリポジトリのデータをすべて削除できます。Cloudflare provider は
空でない R2 bucket を削除できません。そのため Takosumi 管理の実行では、operator が
service-side InstallConfig に、レビュー済み OpenTofu destroy の前に bucket を空にする
versioned `pre_destroy` lifecycle action と明示的な policy を設定します。対象 bucket などの
non-secret 値は allowlisted `cloudflare_account_id` / `object_bucket_name` /
`actions_logs_bucket_name` Output として `TAKOSUMI_OUTPUTS_JSON` に渡します。Takosumi runner は
resolved ProviderBinding ごとの検証済み non-secret provider entry を
`TAKOSUMI_PROVIDER_CONFIGS_JSON` に渡します。Cloudflare の `configuration: {}` または公式
default `base_url` は provider の direct API transport、custom `base_url` はその exact transport
を選びます。URL から billing / managed capacity / ownership authority は推論しません。default
Cloudflare entry がなければ provider token を送信する前に失敗します。Takosumi envelope を持たない
direct CLI / self-host 実行だけは `TAKOS_GIT_CLOUDFLARE_API_MODE=direct` を明示し、
`bun run git:pre-destroy` が bounded page 単位で空にします。
Takosumi 自体は Git 固有の後片付け
ロジックを持たず、OpenTofu Output からコマンドや認証情報を推論しません。

### MCP standalone bearer

直接/self-host client が必要とするときだけ `published_mcp_auth_token` を外部 secret 管理から明示入力し、
Worker 内部の `PUBLISHED_MCP_AUTH_TOKEN` として注入します。空なら static credential は作りません。
値は output せず、Takosumi-managed runtime は `mcp.invoke` Interface OAuth を使います。

## 開発者向け

```sh
bun test              # unit + real Git CLI clone/push/reclone E2E
bun run check         # typecheck
bun run build:worker  # emit local dist/worker.js for self-host applies
tofu fmt -check
tofu validate
```

deploy 後の smoke は exact scope を共有しないため、`TAKOS_GIT_MCP_TOKEN`、
`TAKOS_GIT_READ_TOKEN`、`TAKOS_GIT_WRITE_TOKEN` を別々に渡します。
`TAKOS_GIT_HOSTING_READ_TOKEN` を渡すと `/api/v1` も検証します。旧
`TAKOS_GIT_ACCESS_TOKEN` は移行用 fallback だけで、新しい InterfaceBinding では使いません。
