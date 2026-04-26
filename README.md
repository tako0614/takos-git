# takos-git

Takos Git hosting service.

`takos-git` owns repository hosting, Git Smart HTTP, source object storage,
repository metadata, refs, pull request repository data, source resolution, and
Git-facing API contracts. Browser and CLI clients do not call this service
directly; `takos-app` verifies the user and forwards signed internal requests.
The current app checkout path is `../web` until the rename is completed.

## Layout

```text
apps/git                 internal Git service entrypoint
packages/git-contract    internal/public Git DTOs and signing helpers
```

## Required Env

- `TAKOS_GIT_INTERNAL_URL`
- `TAKOS_INTERNAL_SERVICE_SECRET`
- `TAKOS_GIT_DATABASE_URL`

## Local Commands

```sh
deno task check
deno task dev
```
