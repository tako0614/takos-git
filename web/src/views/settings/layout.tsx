import { Show, type JSX } from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { useSession } from "../../store/session.tsx";
import { Banner, UnderlineNav, type UnderlineNavItem } from "../../ui/index.ts";

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
 * Repo settings shell: an admin-gated sub-nav wrapping the settings panels. Part
 * of the eager shell (it hosts the nested settings routes), so it lives apart
 * from the lazy panel modules in `./index.tsx`.
 */
export function SettingsLayout(props: { children?: JSX.Element }): JSX.Element {
  const repo = useRepo();
  const session = useSession();
  return (
    <div class="space-y-4">
      <Show when={!session.authenticated()}>
        <Banner tone="warning" title="Admin area">
          Settings require an owner/admin session. Sign in to manage this repository.
        </Banner>
      </Show>
      <UnderlineNav aria-label="Settings" items={subTabs(repo.owner(), repo.repo())} />
      <div>{props.children}</div>
    </div>
  );
}
