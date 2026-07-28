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

## Self-host / operator install (OpenTofu)

この例は利用者または operator が自分の環境を変更するための手順で、Takos
ecosystem の公式 artifact 公開や hosted production release ではありません。この
repo の GitHub Actions は deploy / publish を行いません。ecosystem surface の
deploy はこの repository の entrypoint が入口です (まだ存在しないので、作るのが
次の作業です)。共通 rule は `takos-control` の `engineering.policy.json` →
`deploy` が正本です。

module は Cloudflare の feature flag を有効にするまでリソースを作りません。

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var cloudflare_account_id=<id> \
  -var public_url=https://git.example \
  -var takosumi_accounts_issuer_url=https://accounts.example \
  -var worker_bundle_sha256=<release の worker.js.sha256> \
  -var 'env={APP_WORKSPACE_ID="<workspace-id>",APP_CAPSULE_ID="<capsule-id>"}'
```

`public_url` と `takosumi_accounts_issuer_url` は path / query / fragment / userinfo を持たない HTTPS origin を指定します（末尾 `/` は正規化されます）。

managed install では、operator が選んだ immutable
`worker_bundle_url` + `worker_bundle_sha256` を読み込みます。CI artifact を公開物の
代わりにはせず、`dist/worker.js` も commit しません。

`worker_bundle_sha256` は `worker_release_tag` を使う既定経路でも **必須** です。release
manifest (`takosumi-artifact.json`) は mutable な tag 越しに署名なしで取得するので、bundle の
URL は選べても integrity の根拠にはなりません。digest は release ページの
`worker.js.sha256` から operator が out-of-band に固定します。

[`install-options.json`](install-options.json) は、現在実行可能な Cloudflare OpenTofu module を選ぶための任意の
`CapsuleSourceOptions` 表示ドキュメントです。Takosumi 専用 manifest ではなく、通常の Git URL + module path での
直接インストールには不要です。この文書は、それを含む次の通常の安定版タグから利用できます。別クラウドの選択肢は、
対応する実在 module を出荷したときだけ追加します。

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
完全な Interface / Binding evidence shape を検証し、不備があれば安全側に停止します。Interface id / resolved revision
は static module input や Worker env にせず、apply 後に生成される Interface を初回 apply 前に
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

リポジトリ削除 API は即座に namespace を tombstone 化し、ref と Actions pin を隠して
`202 Accepted` を返します。削除世代を記録した quarantine marker と一致する場合だけ、
10 分の quarantine 後に scheduled maintenance が repository-owned object prefix を消します。
同名リポジトリを再作成しても generation が異なるため、古い cleanup が新しいデータを
削除しません。cleanup は idempotent で、失敗時は台帳から再試行されます。
Git object だけでなく、release asset、webhook outbox payload、Actions log / artifact も
同じ cleanup で削除し、tombstone 後の runner callback は書き込み前に拒否します。

Cloudflare provider は
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
bun run check # format/static/type/tests/OpenTofu/build の portable gate
```
