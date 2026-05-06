# AGENTS.md

This repository is the Takos Git hosting service root.

- Own Git Smart HTTP, repository metadata, refs, object storage, source
  resolution, and repository API contracts here.
- Do not implement account/auth/profile/billing/OAuth behavior here; those
  belong to `../app`.
- Do not implement tenant runtime/deploy/container orchestration here; that
  belongs to `../../takosumi`.
- Public browser/CLI auth is verified by `takos-app`; this service accepts
  signed internal actor context only.
