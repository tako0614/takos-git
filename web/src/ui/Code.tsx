import { For, createMemo, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

/**
 * A monospace source renderer with a gutter of line numbers. Syntax highlight
 * is intentionally DEFERRED (Phase-4b may layer a highlighter over the same
 * `<CodeBlock>` seam); this renders plain, wrap-off, horizontally scrollable
 * code — enough for the blob viewer to be live.
 */
export function CodeBlock(props: {
  content: string;
  startLine?: number;
  class?: string;
  wrap?: boolean;
}): JSX.Element {
  const lines = createMemo(() => props.content.replace(/\n$/, "").split("\n"));
  const base = () => props.startLine ?? 1;
  return (
    <div class={cn("overflow-x-auto rounded-md border border-border bg-canvas font-mono text-xs leading-5", props.class)}>
      <table class="w-full border-collapse">
        <tbody>
          <For each={lines()}>
            {(line, index) => (
              <tr class="hover:bg-canvas-subtle">
                <td class="select-none border-r border-border px-3 text-right align-top text-subtle" style={{ width: "1%" }}>
                  {base() + index()}
                </td>
                <td class={cn("px-3 align-top", props.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
                  {line || " "}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** Inline monospace snippet (sha, ref, path). */
export function Mono(props: { children: JSX.Element; class?: string }): JSX.Element {
  return <span class={cn("font-mono text-[0.9em]", props.class)}>{props.children}</span>;
}

/** A short-sha chip. */
export function Sha(props: { value: string; class?: string }): JSX.Element {
  return (
    <span class={cn("rounded bg-neutral-muted px-1.5 py-0.5 font-mono text-xs text-muted", props.class)}>
      {props.value.slice(0, 7)}
    </span>
  );
}
