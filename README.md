# takos-git

Takos-owned internal Git hosting.

`takos-git` is not a generic forge and does not own public profile, catalog,
billing, or OAuth semantics. It is the Takos Git substrate: bare repository
storage, refs, objects, Smart HTTP, source snapshots, and Takos PR metadata.
Browsers and CLI users reach it through `takos-app`, which authenticates the
user and forwards signed internal RPC requests with Git-specific capabilities.
Deploy lifecycle code reaches it through `takosumi` source snapshot calls.

When `TAKOS_GIT_REPOSITORY_ROOT` points at a directory of bare repositories, the
service also reads real refs and objects with the Git CLI and serves Smart HTTP
through `git http-backend`. Repository IDs map to
`${TAKOS_GIT_REPOSITORY_ROOT}/<repositoryId>.git`; IDs that already end in
`.git` are used as-is under the configured root.

Production `takos-git` requires durable storage. When
`TAKOS_GIT_REPOSITORY_ROOT` is configured, `POST /internal/repositories`
initializes a bare repository on disk and persists repository metadata in
SQLite. The default database path is
`${TAKOS_GIT_REPOSITORY_ROOT}/.takos/git.sqlite`; `TAKOS_GIT_DATABASE_URL` can
override it with a `sqlite:///absolute/path.sqlite` URL. The legacy
`${TAKOS_GIT_REPOSITORY_ROOT}/.takos/repositories.json` file is read once as a
migration source when the SQLite store is empty. Schema migrations are recorded
in `schema_migrations`. Process-local metadata exists only for dev/test when
`TAKOS_GIT_DEV_IN_MEMORY_METADATA=true`; production unconfigured storage paths
return stable not-configured errors.

Takos-specific Git authorization is enforced in two layers: every internal route
must carry a valid Takos internal RPC signature with the route's required Git
capability, and repository-scoped routes also require the signed actor account
or space to match the repository `ownerSpaceId`. Write operations require a
write-capable role such as `owner`, `admin`, `maintainer`, or `write`.

Browser and CLI clients do not call internal routes directly; `takos-app`
verifies the user and forwards signed internal requests. Lifecycle-facing
canonical source semantics are owned by the PaaS control plane in `../paas`.

## Layout

```text
apps/git                 internal Git service entrypoint
packages/git-contract    internal/public Git DTOs, paths, and capabilities
```

## Env

- `TAKOS_INTERNAL_SERVICE_SECRET` is required for signed internal endpoints.
- `TAKOS_GIT_INTERNAL_CALLERS` defaults to `takos-app,takosumi,takos-agent`.
- `TAKOS_GIT_INTERNAL_URL` is consumed by callers when they route to this shell.
- `TAKOS_GIT_REPOSITORY_ROOT` enables bare-repository ref/object reads and Smart
  HTTP hosting. Smart HTTP requests still require valid Takos internal signed
  request headers; normal Git clients cannot call these paths directly.
- `TAKOS_GIT_DATABASE_URL` optionally points at the SQLite metadata database
  with `sqlite:///absolute/path.sqlite`. When unset, the database lives under
  the repository root.
- `TAKOS_GIT_DEV_IN_MEMORY_METADATA=true` enables process-local metadata for
  dev/test only. Do not use it for production.
- The production `Dockerfile` installs the `git` CLI and runs the service with
  `--allow-run=git`; do not remove that binary dependency while Smart HTTP and
  Git object reads shell out to Git.

## Production Storage Ramp-Up

1. Install the `git` CLI in the runtime image. Smart HTTP shells out to
   `git http-backend`, and repository reads use `git for-each-ref`,
   `git cat-file`, `git ls-tree`, and related plumbing commands.
2. Provision a durable filesystem path for bare repositories, for example
   `/var/lib/takos-git/repositories`, owned by the `takos-git` process user.
3. Set `TAKOS_GIT_REPOSITORY_ROOT=/var/lib/takos-git/repositories`. Leave
   `TAKOS_GIT_DEV_IN_MEMORY_METADATA` unset in production.
4. Either leave `TAKOS_GIT_DATABASE_URL` unset to use
   `${TAKOS_GIT_REPOSITORY_ROOT}/.takos/git.sqlite`, or set an absolute SQLite
   URL such as `sqlite:///var/lib/takos-git/metadata/git.sqlite`.
5. Start `takos-git` and create repositories through the signed internal API
   (`POST /internal/repositories`) via `takos-app`. The service initializes the
   mapped bare repo and records metadata in SQLite.
6. Verify the first repository with
   `git --git-dir "$TAKOS_GIT_REPOSITORY_ROOT/<id>.git" fsck --no-dangling` and
   a signed `GET /internal/repositories/<id>/refs` call.

For local storage experiments without an API caller, run:

```sh
deno task seed:dev local/demo
export TAKOS_GIT_REPOSITORY_ROOT="$PWD/.takos-git/repositories"
unset TAKOS_GIT_DATABASE_URL
deno task dev
```

The seed task creates a bare repository and writes `.takos/repositories.json`;
on first startup with an empty SQLite database, `takos-git` imports that
metadata and serves the repository as active.

## Current Internal API Shape

- `GET /internal/repositories` lists repository summaries from the configured
  SQLite metadata store, or from process memory when no repository root/database
  is configured.
- `POST /internal/repositories` creates repository metadata and initializes the
  mapped bare repository. The default initialization creates an empty initial
  commit, `refs/heads/<defaultBranch>`, and `HEAD`. Use
  `initialization.mode: "bare"` for an empty bare repository.
- `GET /internal/repositories/:repositoryId` reads repository metadata and refs.
- `PATCH /internal/repositories/:repositoryId` updates metadata and replaces Git
  refs with `git update-ref` when `refs` is provided.
- `DELETE /internal/repositories/:repositoryId` removes the metadata record. It
  does not delete the bare repository directory, but refs/object/Smart HTTP
  access is gated by active metadata.
- `POST /internal/source/resolve` resolves literal commit IDs directly when no
  repository root is configured. When a repository root is configured and the
  repository exists, literal IDs are verified with Git as commits before
  success. It resolves `main`, `refs/heads/main`, tags, or other refs to their
  commit target from the configured bare repository first, then from in-memory
  metadata only when real storage is not configured. The request body is only
  `repositoryId` and `sourceRef`; actor context is carried by the signed
  internal headers and must not be duplicated in the body.
- `GET /internal/repositories/:repositoryId/refs` lists refs from the configured
  bare repository, or from in-memory metadata when no repository root is
  configured and metadata exists.
- `GET /internal/repositories/:repositoryId/tree?ref=<ref>&path=<path>` lists a
  tree from the configured bare repository.
- `GET /internal/repositories/:repositoryId/blob?ref=<ref>&path=<path>` returns
  blob content as UTF-8 or base64.
- `GET /internal/repositories/:repositoryId/commits?ref=<ref>&limit=<n>` lists
  commit summaries from the configured bare repository.
- `GET /internal/objects/:repositoryId/:objectId` reads a Git object from the
  configured bare repository and returns `git cat-file -p` pretty output, not
  raw loose-object storage bytes. Responses include `x-takos-git-object-*`
  headers and `x-takos-git-object-format: git-cat-file-pretty`.
- `GET /internal/objects/:repositoryId/:objectId/raw` reads a Git object from
  the configured bare repository and returns `git cat-file <type>` content with
  `x-takos-git-object-format: git-cat-file-raw`.
- `GET /internal/repositories/:repositoryId/pull-requests` lists SQLite-backed
  pull request records, optionally filtered with `?status=open|closed|merged`.
- `POST /internal/repositories/:repositoryId/pull-requests` creates PR metadata
  for a head/base branch pair.
- `GET` / `PATCH /internal/repositories/:repositoryId/pull-requests/:number`
  reads or updates PR metadata, including closed/merged status.
- `POST /internal/repositories/:repositoryId/pull-requests/:number/comments` and
  `/reviews` append PR discussion/review metadata.
- `POST /internal/source/snapshot` resolves a ref to an immutable Git source
  snapshot with commit SHA, tree file list, optional manifest content, digest,
  and capture time. This is the PaaS-facing source snapshot primitive.
- Smart HTTP-shaped paths such as `/owner/repo.git/info/refs`,
  `/owner/repo.git/git-upload-pack`, and `/owner/repo.git/git-receive-pack` are
  served by `git http-backend` when `TAKOS_GIT_REPOSITORY_ROOT` is configured
  and the request carries a valid v3 Takos internal RPC envelope. Smart HTTP is
  also gated by active repository metadata and forwards Git protocol v2 headers
  to `git http-backend`. Unsigned clone, fetch, and push requests are rejected
  with `401`. The public Git client entry point is `takos-app`, which
  authenticates the user and forwards with `git.repo.read` or `git.repo.write`.

## Local Commands

```sh
deno task check
deno task lint
deno task fmt
deno task test
deno task dev
deno task smoke:live
```

`deno task smoke:live` is opt-in for a deployed or otherwise running service. It
skips when `TAKOS_GIT_INTERNAL_URL` is unset, checks `GET /health` when it is
set, and also performs a signed `GET /internal/repositories` when
`TAKOS_INTERNAL_SERVICE_SECRET` is present.
