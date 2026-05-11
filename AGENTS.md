# AGENTS.md — takos-git (Takos Git hosting service)

`takos-git` は Takos の **Git hosting service** で、 Git Smart HTTP / repository
metadata / refs / object storage / source resolution / repository API contracts
を所有する。 ecosystem の上位 sibling product である `takosumi-git` (workflow /
git bridge to takosumi kernel) とは別物 — 名前が紛らわしいが domain が異なる。

## 責務

### 持つ

- Git Smart HTTP hosting (clone / push / fetch)
- repository metadata / refs / object storage
- source snapshot resolution (Takosumi kernel への source provenance)
- repository API contracts (signed internal RPC 受け入れ)
- Takos Git authorization (signed internal actor context の verify)

### 持たない

- account / auth / profile / billing / OAuth behavior (`../app/` の責務)
- tenant runtime / deploy / container orchestration (`../../takosumi/` の責務)
- browser / CLI auth verify そのもの (`takos-app` が verify した後 signed
  internal actor context として受ける)

## 隣接 product との contract

- **Upstream**: 直接の upstream なし (Takos product 内の self-contained service)
- **Downstream**: Takos product (`../app/` が browser / CLI auth を verify
  した後の signed internal RPC で接続)、 Takosumi kernel (control plane が
  source snapshot 取得のため呼ぶ)
- **Sibling**: `../app/` (auth verify 委譲先)、 `../agent/` (independent
  service)

## Substitutability

代替実装可: bare repository storage を持つ Git HTTP server なら replace 可能。
ただし signed internal RPC protocol は Takos contract に従う必要がある。

## Workflow

```bash
cd takos/git
deno task check
deno task lint
deno task fmt
deno task test
deno task dev
deno task smoke:live
```

## 関連 docs

- [`README.md`](README.md) — service overview と quickstart
- [`docs/`](docs/) — production storage / signed RPC / API spec (存在すれば)
