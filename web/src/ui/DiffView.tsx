import { For, Show, createSignal, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";
import { Icons } from "../lib/Icons.tsx";
import type { DiffHunk, DiffLine, FileDiff } from "../api/types.ts";

/**
 * Unified-diff renderer seam. Consumes the server `DiffPayload` file/hunk shape
 * (`git/commit-diff.ts` → `buildDiffPayload`) and is shared by the commit view
 * and PR files view. Split-diff / inline review-comment anchoring is left for
 * Phase-4b to layer on top of the same `<FileDiff>` per-line rows.
 */

const STATUS_TONE: Record<string, string> = {
  added: "text-success",
  deleted: "text-danger",
  modified: "text-attention",
  renamed: "text-accent",
  copied: "text-accent",
};

function lineClass(type: DiffLine["type"]): string {
  if (type === "add") return "bg-success-subtle";
  if (type === "del") return "bg-danger-subtle";
  return "";
}

function marker(type: DiffLine["type"]): string {
  return type === "add" ? "+" : type === "del" ? "-" : " ";
}

function HunkRows(props: { hunk: DiffHunk }): JSX.Element {
  return (
    <>
      <tr>
        <td colSpan={3} class="bg-accent-subtle px-3 py-1 font-mono text-xs text-muted">
          {props.hunk.header}
        </td>
      </tr>
      <For each={props.hunk.lines}>
        {(line) => (
          <tr class={cn("font-mono text-xs leading-5", lineClass(line.type))}>
            <td class="w-10 select-none border-r border-border px-2 text-right text-subtle">
              {line.oldLine ?? ""}
            </td>
            <td class="w-10 select-none border-r border-border px-2 text-right text-subtle">
              {line.newLine ?? ""}
            </td>
            <td class="whitespace-pre px-3">
              <span class="select-none text-subtle">{marker(line.type)} </span>
              {line.text}
            </td>
          </tr>
        )}
      </For>
    </>
  );
}

/** A single file's diff, collapsible, with an add/del summary. */
export function FileDiffView(props: { file: FileDiff }): JSX.Element {
  const [open, setOpen] = createSignal(true);
  return (
    <div class="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        class="flex w-full items-center gap-2 bg-canvas-subtle px-3 py-2 text-left text-sm hover:bg-canvas-inset"
        onClick={() => setOpen((v) => !v)}
      >
        <Icons.ChevronDown class={cn("h-4 w-4 shrink-0 text-muted transition-transform", !open() && "-rotate-90")} />
        <span class={cn("shrink-0 text-xs font-semibold uppercase", STATUS_TONE[props.file.status] ?? "text-muted")}>
          {props.file.status[0]}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs">
          <Show when={props.file.oldPath && props.file.oldPath !== props.file.path}>
            <span class="text-subtle">{props.file.oldPath} → </span>
          </Show>
          {props.file.path}
        </span>
        <span class="shrink-0 font-mono text-xs">
          <span class="text-success">+{props.file.additions}</span>{" "}
          <span class="text-danger">-{props.file.deletions}</span>
        </span>
      </button>
      <Show when={open()}>
        <Show
          when={!props.file.binary}
          fallback={<div class="px-3 py-4 text-center text-xs text-muted">Binary file not shown.</div>}
        >
          <div class="overflow-x-auto bg-canvas">
            <table class="w-full border-collapse">
              <tbody>
                <For each={props.file.hunks ?? []}>{(hunk) => <HunkRows hunk={hunk} />}</For>
              </tbody>
            </table>
            <Show when={(props.file.hunks?.length ?? 0) === 0}>
              <div class="px-3 py-4 text-center text-xs text-muted">No line changes to display.</div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** The full multi-file diff for a commit / compare / PR. */
export function DiffView(props: { files: readonly FileDiff[]; class?: string }): JSX.Element {
  return (
    <div class={cn("space-y-4", props.class)}>
      <Show
        when={props.files.length > 0}
        fallback={<p class="py-6 text-center text-sm text-muted">No file changes.</p>}
      >
        <For each={props.files}>{(file) => <FileDiffView file={file} />}</For>
      </Show>
    </div>
  );
}
