import { type JSX } from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { collaboratorsApi, branchProtectionApi, webhooksApi } from "../../api/admin.ts";
import { Seam } from "../_seam.tsx";
import { Probe } from "../_probe.tsx";

export { SettingsLayout } from "./layout.tsx";

export function GeneralSettingsView(): JSX.Element {
  return (
    <Seam
      feature="Settings — General"
      summary="Description, visibility, default branch, feature toggles, transfer/delete."
      apiModule="reposApi.update / reposApi.remove"
      components={["GeneralSettingsForm", "DangerZone (transfer/delete)"]}
      routes={["/:owner/:repo/settings"]}
    />
  );
}

export function CollaboratorsSettingsView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Settings — Collaborators"
      summary="List collaborators + roles; add/set role (reader/writer/maintainer/admin); remove. Net-new ACL."
      apiModule="collaboratorsApi (api/admin.ts): list, set, remove"
      components={["CollaboratorList", "role picker", "add-collaborator"]}
      routes={["/:owner/:repo/settings/collaborators"]}
    >
      <Probe
        label="Collaborators"
        fetcher={() => collaboratorsApi.list(repo.owner(), repo.repo())}
        render={(page) => `${page.items.length}`}
      />
    </Seam>
  );
}

export function BranchesSettingsView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Settings — Branch protection"
      summary="Per-pattern rules: required approvals/checks, linear history, restrict pushers, force-push/deletion toggles. Enforced server-side in the ref-write path."
      apiModule="branchProtectionApi (api/admin.ts): list, get, put, remove"
      components={["BranchProtectionList", "rule editor"]}
      routes={["/:owner/:repo/settings/branches"]}
    >
      <Probe
        label="Protection rules"
        fetcher={() => branchProtectionApi.list(repo.owner(), repo.repo())}
        render={(page) => `${page.items.length}`}
      />
    </Seam>
  );
}

export function WebhooksSettingsView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Settings — Webhooks"
      summary="Subscriptions (url/secret/events/active), delivery log with redeliver + ping. HMAC-signed, async delivery."
      apiModule="webhooksApi (api/admin.ts): list, create, update, remove, ping, deliveries"
      components={["WebhookList", "webhook editor", "DeliveryLog"]}
      routes={["/:owner/:repo/settings/webhooks"]}
    >
      <Probe
        label="Webhooks"
        fetcher={() => webhooksApi.list(repo.owner(), repo.repo())}
        render={(page) => `${page.items.length}`}
      />
    </Seam>
  );
}
