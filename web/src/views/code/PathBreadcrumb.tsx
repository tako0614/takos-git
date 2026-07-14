import { type JSX } from "solid-js";
import { Breadcrumb, type Crumb } from "../../ui/index.ts";
import { pathCrumbs, repoBase, treeHref } from "./helpers.ts";

/**
 * File-path breadcrumb: `repo / dir / dir / name`. Directory crumbs link to the
 * tree at that ref; the final crumb (current dir or file) is inert. The repo
 * crumb returns to the code overview.
 */
export function PathBreadcrumb(props: {
  owner: string;
  repo: string;
  refName: string;
  path: string;
  /** When true (blob view) the last crumb is a file name, not a directory. */
  isFile?: boolean;
  class?: string;
}): JSX.Element {
  const items = (): Crumb[] => {
    const crumbs = pathCrumbs(props.path);
    const list: Crumb[] = [
      { label: props.repo, href: repoBase(props.owner, props.repo) },
    ];
    crumbs.forEach((crumb, index) => {
      const last = index === crumbs.length - 1;
      list.push({
        label: crumb.name,
        href: last ? undefined : treeHref(props.owner, props.repo, props.refName, crumb.path),
      });
    });
    return list;
  };
  return <Breadcrumb class={props.class} items={items()} />;
}
