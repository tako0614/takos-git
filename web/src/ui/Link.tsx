import { splitProps, type JSX } from "solid-js";
import { A, type AnchorProps } from "@solidjs/router";
import { cn } from "../lib/cn.ts";
import { toSafeHref } from "../lib/safeHref.ts";

/** Internal, client-routed link (GitHub-blue, subtle underline on hover). */
export function Link(props: AnchorProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <A class={cn("text-accent hover:underline", local.class)} {...rest}>
      {local.children}
    </A>
  );
}

export interface ExternalLinkProps
  extends JSX.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * External link with `toSafeHref` scheme validation (no javascript:/data:) and
 * safe `rel`. Renders inert text when the href is rejected.
 */
export function ExternalLink(props: ExternalLinkProps): JSX.Element {
  const [local, rest] = splitProps(props, ["href", "class", "children"]);
  const safe = () => toSafeHref(local.href);
  return (
    <>
      {safe() ? (
        <a
          href={safe() as string}
          class={cn("text-accent hover:underline", local.class)}
          rel="noopener noreferrer nofollow"
          {...rest}
        >
          {local.children}
        </a>
      ) : (
        <span class={cn("text-muted", local.class)}>{local.children}</span>
      )}
    </>
  );
}
