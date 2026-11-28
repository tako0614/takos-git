/**
 * Route-aware document title formatting for takos-git.
 * Pure helper so both AppShell and unit tests share the exact mapping.
 */

const PRODUCT_TITLE = "Takos Git";

const REPO_SECTIONS: Readonly<Record<string, string>> = {
  issues: "Issues",
  pulls: "Pull requests",
  actions: "Actions",
  releases: "Releases",
  settings: "Settings",
  commits: "Commits",
  commit: "Commit",
  compare: "Compare",
  blob: "Code",
  tree: "Code",
};

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function formatDocumentTitle(pathname: string, search = ""): string {
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length === 0) return `Repositories — ${PRODUCT_TITLE}`;
  if (segments.length === 1) return PRODUCT_TITLE;

  const [owner, repo, section, detail] = segments;
  const repoLabel = `${owner}/${repo}`;

  if (!section) return `${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "issues" && detail === "new") return `New issue · ${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "issues" && detail && /^\d+$/u.test(detail)) return `Issue #${detail} · ${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "pulls" && detail && /^\d+$/u.test(detail)) return `Pull request #${detail} · ${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "commit" && detail) return `Commit ${detail.slice(0, 7)} · ${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "actions" && detail === "runs" && segments[4]) return `Run · ${repoLabel} — ${PRODUCT_TITLE}`;
  if (section === "releases" && search) {
    const tag = new URLSearchParams(search).get("tag")?.trim();
    if (tag) return `Release ${tag} · ${repoLabel} — ${PRODUCT_TITLE}`;
  }

  const sectionLabel = REPO_SECTIONS[section];
  if (sectionLabel) return `${sectionLabel} · ${repoLabel} — ${PRODUCT_TITLE}`;
  return `${repoLabel} — ${PRODUCT_TITLE}`;
}

export function applyDocumentTitle(pathname: string, search = ""): void {
  if (typeof document !== "undefined") {
    document.title = formatDocumentTitle(pathname, search);
  }
}
