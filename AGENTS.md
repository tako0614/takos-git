# AGENTS.md

This repository is the Takos Git hosting service root.

- Own Git Smart HTTP, repository metadata, refs, object storage, source
  resolution, and repository API contracts here.
- Do not implement account/auth/profile/billing/OAuth behavior here; those
  belong to `../web`.
- Do not implement tenant runtime/deploy/container orchestration here; that
  belongs to `../paas`.
- Public browser/CLI auth is verified by `takos-web`; this service accepts
  signed internal actor context only.
