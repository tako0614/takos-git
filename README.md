# takos-git

Takos Git hosting service shell.

`takos-git` currently provides Git DTOs/signing helpers and a small internal
service shell for compatibility routes. It has a process-local in-memory
repository metadata store, basic repository CRUD-ish internal endpoints, and
branch/tag ref source resolution for refs already present in that store. Literal
40-hex and 64-hex commit IDs are accepted directly.

When `TAKOS_GIT_REPOSITORY_ROOT` points at a directory of bare repositories, the
service also reads real refs and objects with the Git CLI and serves Smart HTTP
through `git http-backend`. Repository IDs map to
`${TAKOS_GIT_REPOSITORY_ROOT}/<repositoryId>.git`; IDs that already end in
`.git` are used as-is under the configured root.

This checkout still does not implement repository creation on disk, pull request
repository data, durable metadata persistence, or Takos-specific Git
authorization. Unconfigured Git storage paths return `501` with a stable
not-implemented code.

Browser and CLI clients do not call internal routes directly; `takos-app`
verifies the user and forwards signed internal requests. Lifecycle-facing
canonical source semantics are owned by the PaaS control plane in `../paas`.

## Layout

```text
apps/git                 internal Git service entrypoint
packages/git-contract    internal/public Git DTOs and signing helpers
```

## Env

- `TAKOS_INTERNAL_SERVICE_SECRET` is required for signed internal endpoints.
- `TAKOS_GIT_INTERNAL_CALLERS` defaults to `takos-app,takos-paas`.
- `TAKOS_GIT_INTERNAL_URL` is consumed by callers when they route to this shell.
- `TAKOS_GIT_REPOSITORY_ROOT` enables bare-repository ref/object reads and Smart
  HTTP hosting.
- `TAKOS_GIT_DATABASE_URL` is reserved for a future full Git service and is not
  used by the current stub implementation.

## Current Internal API Shape

- `GET /internal/repositories` lists in-memory repository summaries.
- `POST /internal/repositories` creates in-memory repository metadata with
  optional refs.
- `GET /internal/repositories/:repositoryId` reads repository metadata and refs.
- `PATCH /internal/repositories/:repositoryId` updates metadata and replaces
  refs when `refs` is provided.
- `DELETE /internal/repositories/:repositoryId` removes the in-memory record.
- `POST /internal/source/resolve` resolves literal commit IDs directly, and
  resolves `main`, `refs/heads/main`, tags, or other refs to their commit target
  from the configured bare repository first, then from in-memory metadata. The
  request body is only `repositoryId` and `sourceRef`; actor context is carried
  by the signed internal headers and must not be duplicated in the body.
- `GET /internal/repositories/:repositoryId/refs` lists refs from the configured
  bare repository, or from in-memory metadata when no repository root is
  configured and metadata exists.
- `GET /internal/objects/:repositoryId/:objectId` reads a Git object from the
  configured bare repository and returns the pretty-printed object bytes with
  `x-takos-git-object-*` headers.
- Smart HTTP-shaped paths such as `/owner/repo.git/info/refs`,
  `/owner/repo.git/git-upload-pack`, and `/owner/repo.git/git-receive-pack` are
  served by `git http-backend` when `TAKOS_GIT_REPOSITORY_ROOT` is configured.

## Local Commands

```sh
deno task check
deno task lint
deno task fmt
deno task test
deno task dev
```
