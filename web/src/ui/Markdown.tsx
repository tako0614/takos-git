import { type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";
import { toSafeHref } from "../lib/safeHref.ts";

/**
 * A deliberately small, SAFE Markdown renderer for issue/PR/release bodies.
 *
 * Safety model: it NEVER sets innerHTML. Everything is built as SolidJS JSX
 * nodes, so untrusted body text can only ever become DOM *text*, never markup.
 * Links are scheme-validated with `toSafeHref` (no javascript:/data:). This is
 * not a full CommonMark implementation — it covers headings, paragraphs, fenced
 * + inline code, bold/italic, links, lists, blockquotes, and rules. Phase-4b may
 * extend it (tables, task lists) but must preserve the no-innerHTML invariant.
 */

type Inline = string | JSX.Element;

function renderInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let rest = text;
  // Ordered by precedence; code first so its content isn't re-parsed.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/;
  let guard = 0;
  while (rest && guard++ < 2000) {
    const match = pattern.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code class="rounded bg-neutral-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em>{token.slice(1, -1)}</em>);
    } else {
      // link [text](url)
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = m ? toSafeHref(m[2]) : null;
      if (m && href) {
        nodes.push(
          <a href={href} rel="noopener noreferrer nofollow" class="text-accent hover:underline">
            {m[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

function renderBlocks(source: string): JSX.Element[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i += 1; // closing fence
      blocks.push(
        <pre class="overflow-x-auto rounded-md border border-border bg-canvas-subtle p-3 text-xs">
          <code class="font-mono">{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const sizes = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"];
      blocks.push(
        <p class={cn("mt-3 font-semibold text-fg", sizes[level - 1])}>
          {renderInline(heading[2])}
        </p>,
      );
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr class="my-3 border-border" />);
      i += 1;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote class="border-l-4 border-border pl-3 text-muted">
          {renderInline(buf.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // list (unordered or ordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      }
      const children = items.map((item) => <li>{renderInline(item)}</li>);
      blocks.push(
        ordered ? (
          <ol class="ml-5 list-decimal space-y-1">{children}</ol>
        ) : (
          <ul class="ml-5 list-disc space-y-1">{children}</ul>
        ),
      );
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // paragraph (accumulate until blank/structural line)
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    blocks.push(<p class="leading-relaxed">{renderInline(buf.join(" "))}</p>);
  }

  return blocks;
}

/** Render trusted-source-unknown Markdown as safe DOM (never innerHTML). */
export function Markdown(props: { source: string | null | undefined; class?: string }): JSX.Element {
  return (
    <div class={cn("space-y-2 text-sm text-fg break-words", props.class)}>
      {props.source ? renderBlocks(props.source) : <p class="text-muted">No description provided.</p>}
    </div>
  );
}
