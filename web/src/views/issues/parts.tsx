/**
 * Shared building blocks for the Issues views: principal helpers, the open/closed
 * state icon + badge, label chips, a Write/Preview Markdown editor, and the
 * GitHub-style timeline comment card. Everything renders through the frozen
 * design system (never `innerHTML`; user text always goes through `Markdown`).
 */
import { createSignal, Index, Show, type JSX } from "solid-js";
import { cn } from "../../lib/cn.ts";
import {
  Avatar,
  Icons,
  Markdown,
  RelativeTime,
  StateLabel,
  Textarea,
} from "../../ui/index.ts";
import type { LabelDto, PrincipalRef } from "../../api/types.ts";

/** Best display name for a principal: display name, else subject, else unknown. */
export function principalName(
  p: { readonly displayName: string | null; readonly subject: string } | null | undefined,
): string {
  return p?.displayName?.trim() || p?.subject || "unknown";
}

/** GitHub's row glyph — a green open-circle or a purple closed check. */
export function IssueStateIcon(props: { state: "open" | "closed"; class?: string }): JSX.Element {
  return (
    <Show
      when={props.state === "open"}
      fallback={
        <span
          class={cn("inline-flex h-4 w-4 items-center justify-center text-done", props.class)}
          title="Closed"
          aria-label="Closed"
        >
          <Icons.Check class="h-4 w-4" />
        </span>
      }
    >
      <span
        class={cn("inline-block rounded-full border-2 border-success", props.class)}
        style={{ width: "14px", height: "14px" }}
        title="Open"
        aria-label="Open"
      />
    </Show>
  );
}

/** The large Open / Closed pill shown in the issue header. */
export function IssueStateBadge(props: { state: "open" | "closed" }): JSX.Element {
  return (
    <StateLabel
      state={props.state}
      icon={
        props.state === "open" ? (
          <Icons.Info class="h-3.5 w-3.5" />
        ) : (
          <Icons.Check class="h-3.5 w-3.5" />
        )
      }
    />
  );
}

/** A colored issue-label pill from a `LabelDto` (its color is a 6-hex string). */
export function LabelChip(props: { label: LabelDto }): JSX.Element {
  const hex = () => `#${(props.label.color || "8b949e").replace(/^#/, "")}`;
  return (
    <span
      class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-4"
      style={{
        "border-color": `color-mix(in srgb, ${hex()} 55%, transparent)`,
        background: `color-mix(in srgb, ${hex()} 16%, transparent)`,
        color: hex(),
      }}
      title={props.label.description ?? undefined}
    >
      {props.label.name}
    </span>
  );
}

/** Inline run of label chips (issue rows + detail). */
export function LabelChips(props: { labels: readonly LabelDto[]; class?: string }): JSX.Element {
  return (
    <Show when={props.labels.length > 0}>
      <span class={cn("inline-flex flex-wrap items-center gap-1", props.class)}>
        <Index each={props.labels}>{(label) => <LabelChip label={label()} />}</Index>
      </span>
    </Show>
  );
}

/**
 * A textarea with Write / Preview tabs. The preview renders through the safe
 * `Markdown` component. Controlled via `value` / `onInput`.
 */
export function MarkdownEditor(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  rows?: number;
  class?: string;
}): JSX.Element {
  const [tab, setTab] = createSignal<"write" | "preview">("write");
  const tabClass = (active: boolean) =>
    cn(
      "tg-focus rounded-md px-3 py-1 text-sm",
      active
        ? "border border-border bg-canvas font-semibold text-fg"
        : "border border-transparent text-muted hover:text-fg",
    );
  return (
    <div class={cn("rounded-md border border-border bg-canvas", props.class)}>
      <div
        role="tablist"
        aria-label="Comment editor"
        class="flex items-center gap-1 border-b border-border bg-canvas-subtle px-2 py-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab() === "write"}
          class={tabClass(tab() === "write")}
          onClick={() => setTab("write")}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === "preview"}
          class={tabClass(tab() === "preview")}
          onClick={() => setTab("preview")}
        >
          Preview
        </button>
      </div>
      <div class="p-2">
        <Show
          when={tab() === "write"}
          fallback={
            <div class="min-h-[96px] border-b border-border px-2 pb-3 pt-1">
              <Markdown source={props.value} />
            </div>
          }
        >
          <Textarea
            id={props.id}
            value={props.value}
            disabled={props.disabled}
            placeholder={props.placeholder ?? "Leave a comment"}
            rows={props.rows ?? 5}
            class="border-transparent bg-transparent focus:border-transparent"
            onInput={(e) => props.onInput(e.currentTarget.value)}
          />
        </Show>
      </div>
    </div>
  );
}

/**
 * A GitHub-style timeline comment: an avatar, a header bar (author + relative
 * time + optional actions), and a Markdown body (or arbitrary children).
 */
export function TimelineComment(props: {
  author: PrincipalRef | null;
  createdAt: number;
  edited?: boolean;
  emphasis?: boolean;
  headerExtra?: JSX.Element;
  headerActions?: JSX.Element;
  body?: string | null;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class="flex gap-3">
      <Avatar name={principalName(props.author)} size={40} class="mt-0.5" />
      <div class="min-w-0 flex-1 rounded-md border border-border">
        <div
          class={cn(
            "flex flex-wrap items-center gap-2 rounded-t-md border-b border-border px-4 py-2 text-sm",
            props.emphasis ? "bg-accent-subtle" : "bg-canvas-subtle",
          )}
        >
          <span class="font-semibold text-fg">{principalName(props.author)}</span>
          <span class="text-muted">
            commented <RelativeTime epochMs={props.createdAt} />
          </span>
          <Show when={props.edited}>
            <span class="text-xs text-muted" title="This comment was edited">
              · edited
            </span>
          </Show>
          {props.headerExtra}
          <Show when={props.headerActions}>
            <span class="ml-auto flex items-center gap-1">{props.headerActions}</span>
          </Show>
        </div>
        <div class="px-4 py-3">
          {props.children ?? <Markdown source={props.body} />}
        </div>
      </div>
    </div>
  );
}
