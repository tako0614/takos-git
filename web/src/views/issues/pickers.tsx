/**
 * Dropdown pickers for issue triage — labels, milestone, assignees — plus the
 * small `Popover` primitive they share. The list-page filter dropdowns reuse the
 * same option-list styling. Multi-select editors (labels, assignees) batch their
 * mutation and apply it when the popover closes; single-select (milestone,
 * filters) apply immediately.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { cn } from "../../lib/cn.ts";
import { Icons, Spinner, TextInput } from "../../ui/index.ts";
import { LabelChip, principalName } from "./parts.tsx";
import type { LabelDto, MilestoneDto, PrincipalRef } from "../../api/types.ts";

/**
 * A lightweight anchored popover: a trigger + a floating panel that closes on
 * outside-click / Escape and fires `onClose` on the open→closed transition
 * (used by the multi-select editors to flush a batched change). CSP-safe — all
 * handlers are Solid event props, no inline attributes.
 */
export function Popover(props: {
  trigger: (state: { open: boolean }) => JSX.Element;
  triggerLabel: string;
  children: (api: { close: () => void }) => JSX.Element;
  align?: "left" | "right";
  width?: string;
  onClose?: () => void;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const close = () => {
    if (open()) {
      setOpen(false);
      props.onClose?.();
    }
  };
  const onDocClick = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  createEffect(() => {
    if (open()) {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    } else {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    }
  });
  onCleanup(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={props.triggerLabel}
        class="tg-focus w-full rounded-md text-left"
        onClick={() => (open() ? close() : setOpen(true))}
      >
        {props.trigger({ open: open() })}
      </button>
      <Show when={open()}>
        <div
          role="menu"
          class={cn(
            "absolute z-40 mt-1 overflow-hidden rounded-md border border-border bg-canvas shadow-lg",
            props.align === "left" ? "left-0" : "right-0",
            props.width ?? "w-72",
          )}
        >
          {props.children({ close })}
        </div>
      </Show>
    </div>
  );
}

/** A searchable, checkbox option list rendered inside a popover panel. */
function OptionList<T>(props: {
  heading: string;
  options: readonly T[];
  loading?: boolean;
  error?: string;
  empty?: string;
  keyOf: (item: T) => string;
  selected: (item: T) => boolean;
  onToggle: (item: T) => void;
  renderOption: (item: T) => JSX.Element;
  search?: { value: string; onInput: (v: string) => void; placeholder: string };
  footer?: JSX.Element;
}): JSX.Element {
  return (
    <div>
      <div class="border-b border-border px-3 py-2 text-xs font-semibold text-muted">
        {props.heading}
      </div>
      <Show when={props.search}>
        {(s) => (
          <div class="border-b border-border p-2">
            <TextInput
              value={s().value}
              placeholder={s().placeholder}
              onInput={(e) => s().onInput(e.currentTarget.value)}
            />
          </div>
        )}
      </Show>
      <div class="max-h-64 overflow-y-auto py-1">
        <Show
          when={!props.loading}
          fallback={
            <div class="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted">
              <Spinner /> Loading…
            </div>
          }
        >
          <Show when={!props.error} fallback={<p class="px-3 py-3 text-sm text-danger">{props.error}</p>}>
            <Show
              when={props.options.length > 0}
              fallback={<p class="px-3 py-3 text-sm text-muted">{props.empty ?? "Nothing to show."}</p>}
            >
              <Index each={props.options}>
                {(item) => (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={props.selected(item())}
                    class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle"
                    onClick={() => props.onToggle(item())}
                  >
                    <span class="mt-0.5 w-4 shrink-0 text-accent">
                      <Show when={props.selected(item())}>
                        <Icons.Check class="h-4 w-4" />
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1">{props.renderOption(item())}</span>
                  </button>
                )}
              </Index>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={props.footer}>
        <div class="border-t border-border p-2">{props.footer}</div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar editors (multi/single-select, batched apply on close)
// ---------------------------------------------------------------------------

/** Edit an issue's label set. Applies the batched selection when it closes. */
export function LabelEditor(props: {
  all: readonly LabelDto[];
  loading?: boolean;
  error?: string;
  selected: readonly string[];
  disabled?: boolean;
  onApply: (names: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<string[]>([...props.selected]);
  const [query, setQuery] = createSignal("");
  // Re-seed the draft whenever the underlying selection changes upstream.
  createEffect(() => setDraft([...props.selected]));

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? props.all.filter((l) => l.name.toLowerCase().includes(q)) : props.all;
  });
  const toggle = (name: string) =>
    setDraft((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  const flush = () => {
    const next = draft();
    const changed =
      next.length !== props.selected.length || next.some((n) => !props.selected.includes(n));
    if (changed) props.onApply(next);
  };

  return (
    <Popover
      triggerLabel="Edit labels"
      align="right"
      width="w-72"
      onClose={flush}
      trigger={() => (
        <span class="flex items-center justify-between text-sm font-semibold text-fg hover:text-accent">
          Labels <Icons.Settings class="h-4 w-4 text-muted" />
        </span>
      )}
    >
      {() => (
        <OptionList
          heading="Apply labels to this issue"
          options={filtered()}
          loading={props.loading}
          error={props.error}
          empty="No labels in this repository."
          keyOf={(l) => l.name}
          selected={(l) => draft().includes(l.name)}
          onToggle={(l) => !props.disabled && toggle(l.name)}
          search={{ value: query(), onInput: setQuery, placeholder: "Filter labels" }}
          renderOption={(l) => (
            <span class="flex flex-col gap-0.5">
              <LabelChip label={l} />
              <Show when={l.description}>
                <span class="text-xs text-muted">{l.description}</span>
              </Show>
            </span>
          )}
        />
      )}
    </Popover>
  );
}

/** Edit an issue's assignees. `candidates` is a best-effort principal list. */
export function AssigneeEditor(props: {
  candidates: readonly PrincipalRef[];
  loading?: boolean;
  error?: string;
  selected: readonly string[];
  disabled?: boolean;
  onApply: (subjects: string[]) => void;
  allowManual?: boolean;
}): JSX.Element {
  const [draft, setDraft] = createSignal<string[]>([...props.selected]);
  const [query, setQuery] = createSignal("");
  const [manual, setManual] = createSignal("");
  createEffect(() => setDraft([...props.selected]));

  const options = createMemo(() => {
    // Union of candidates + already-selected subjects not present in candidates.
    const known = new Map(props.candidates.map((c) => [c.subject, c]));
    for (const subject of draft()) {
      if (!known.has(subject)) known.set(subject, { id: subject, subject, displayName: null });
    }
    const list = [...known.values()];
    const q = query().trim().toLowerCase();
    return q
      ? list.filter(
          (p) =>
            p.subject.toLowerCase().includes(q) ||
            (p.displayName ?? "").toLowerCase().includes(q),
        )
      : list;
  });
  const toggle = (subject: string) =>
    setDraft((prev) =>
      prev.includes(subject) ? prev.filter((s) => s !== subject) : [...prev, subject],
    );
  const addManual = () => {
    const s = manual().trim();
    if (s && !draft().includes(s)) setDraft((prev) => [...prev, s]);
    setManual("");
  };
  const flush = () => {
    const next = draft();
    const changed =
      next.length !== props.selected.length || next.some((s) => !props.selected.includes(s));
    if (changed) props.onApply(next);
  };

  return (
    <Popover
      triggerLabel="Edit assignees"
      align="right"
      width="w-72"
      onClose={flush}
      trigger={() => (
        <span class="flex items-center justify-between text-sm font-semibold text-fg hover:text-accent">
          Assignees <Icons.Settings class="h-4 w-4 text-muted" />
        </span>
      )}
    >
      {() => (
        <OptionList
          heading="Assign people"
          options={options()}
          loading={props.loading}
          empty="No collaborators found."
          keyOf={(p) => p.subject}
          selected={(p) => draft().includes(p.subject)}
          onToggle={(p) => !props.disabled && toggle(p.subject)}
          search={{ value: query(), onInput: setQuery, placeholder: "Filter people" }}
          renderOption={(p) => (
            <span class="flex flex-col">
              <span class="font-medium text-fg">{principalName(p)}</span>
              <Show when={p.displayName && p.displayName !== p.subject}>
                <span class="text-xs text-muted">{p.subject}</span>
              </Show>
            </span>
          )}
          footer={
            <Show when={props.allowManual}>
              <div class="flex items-center gap-2">
                <TextInput
                  value={manual()}
                  placeholder="Add by subject id"
                  onInput={(e) => setManual(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addManual();
                    }
                  }}
                />
                <button
                  type="button"
                  class="tg-focus shrink-0 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-canvas-subtle"
                  onClick={addManual}
                >
                  Add
                </button>
              </div>
            </Show>
          }
        />
      )}
    </Popover>
  );
}

/** Edit an issue's milestone (single-select, applies immediately). */
export function MilestoneEditor(props: {
  all: readonly MilestoneDto[];
  loading?: boolean;
  error?: string;
  selected: number | null;
  disabled?: boolean;
  onApply: (milestone: number | null) => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const open = createMemo(() => props.all.filter((m) => m.state === "open"));
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? open().filter((m) => m.title.toLowerCase().includes(q)) : open();
  });
  return (
    <Popover
      triggerLabel="Edit milestone"
      align="right"
      width="w-72"
      trigger={() => (
        <span class="flex items-center justify-between text-sm font-semibold text-fg hover:text-accent">
          Milestone <Icons.Settings class="h-4 w-4 text-muted" />
        </span>
      )}
    >
      {({ close }) => (
        <OptionList
          heading="Set milestone"
          options={filtered()}
          loading={props.loading}
          error={props.error}
          empty="No open milestones."
          keyOf={(m) => String(m.number)}
          selected={(m) => props.selected === m.number}
          onToggle={(m) => {
            if (props.disabled) return;
            props.onApply(props.selected === m.number ? null : m.number);
            close();
          }}
          search={{ value: query(), onInput: setQuery, placeholder: "Filter milestones" }}
          renderOption={(m) => (
            <span class="flex flex-col">
              <span class="font-medium text-fg">{m.title}</span>
              <span class="text-xs text-muted">
                {m.openIssues} open · {m.closedIssues} closed
              </span>
            </span>
          )}
          footer={
            <Show when={props.selected !== null}>
              <button
                type="button"
                class="tg-focus w-full rounded-md px-2 py-1.5 text-left text-sm text-danger hover:bg-canvas-subtle"
                onClick={() => {
                  props.onApply(null);
                  close();
                }}
              >
                Clear milestone
              </button>
            </Show>
          }
        />
      )}
    </Popover>
  );
}
