# takos-git

Takos Git compatibility shell.

`takos-git` currently provides Git DTOs/signing helpers and a small internal
service shell for compatibility routes. It has a process-local in-memory
repository metadata store, basic repository CRUD-ish internal endpoints, and
branch/tag ref source resolution for refs already present in that store. Literal
40-hex and 64-hex commit IDs are accepted directly.

This checkout still does not implement full Git Smart HTTP, repository object
storage, packfile negotiation, pull request repository data, or durable
repository persistence. Smart HTTP-shaped `*.git` paths and internal object
storage paths return `501` with a stable not-implemented code.

Browser and CLI clients do not call this service directly; `takos-app` verifies
the user and forwards signed internal requests. Deploy-facing canonical source
semantics are currently owned by the PaaS control plane in `../paas`, not by
this stub shell.

## Layout

```text
apps/git                 internal Git service entrypoint
packages/git-contract    internal/public Git DTOs and signing helpers
```

## Env

- `TAKOS_INTERNAL_SERVICE_SECRET` is required for signed internal endpoints.
- `TAKOS_GIT_INTERNAL_URL` is consumed by callers when they route to this shell.
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
  resolves `main`, `refs/heads/main`, tags, or other stored refs to their commit
  target when the repository exists in memory. The request body is only
  `repositoryId` and `sourceRef`; actor context is carried by the signed
  internal headers and must not be duplicated in the body.
- `/internal/objects` and `/internal/objects/*` are authenticated but return
  `501 git_object_storage_not_implemented`.
- Smart HTTP-shaped paths such as `/owner/repo.git/info/refs` return
  `501 git_smart_http_not_implemented`.

## Local Commands

```sh
deno task check
deno task lint
deno task fmt
deno task test
deno task dev
```
