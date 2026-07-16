# Takosumi-managed root

This directory is the Takosumi-managed entry root for takos-git. Set the
Capsule Source module path to `deploy/takosumi` only after the operator runner
can install the mirrored `takosjp/takosumi` provider and inject the ambient
Capsule Run identity.

The wrapper calls the repository's plain root module at `../..` and declares
the launcher and MCP Interfaces through `takosumi_interface`. It never creates
InterfaceBindings; consumer authorization remains service-side and
user-approved.

Direct/self-host users should continue to run the repository root. The plain
root intentionally has no dependency on the unpublished Takosumi provider.
