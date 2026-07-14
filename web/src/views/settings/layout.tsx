import { type JSX } from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { UnderlineNav, type UnderlineNavItem } from "../../ui/index.ts";

function subTabs(owner: string, repo: string): UnderlineNavItem[] {
  const base = `/${owner}/${repo}/settings`;
  return [
    { label: "General", href: base, end: true },
    { label: "Collaborators", href: `${base}/collaborators` },
    { label: "Branches", href: `${base}/branches` },
    { label: "Webhooks", href: `${base}/webhooks` },
  ];
}

/**
 * Repo settings shell: the settings sub-nav wrapping the nested panels. Part of
 * the eager shell (it hosts the nested settings routes), so it lives apart from
 * the lazy panel modules in `./index.tsx`. Each panel owns its own admin gating
 * (`AdminGate`) and surfaces the worker's role decision, so the shell only lays
 * out the navigation.
 */
export function SettingsLayout(props: { children?: JSX.Element }): JSX.Element {
  const repo = useRepo();
  return (
    <div class="space-y-4">
      <UnderlineNav aria-label="Settings" items={subTabs(repo.owner(), repo.repo())} />
      <div>{props.children}</div>
    </div>
  );
}
