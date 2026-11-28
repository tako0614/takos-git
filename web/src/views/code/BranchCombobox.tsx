import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  type JSX,
} from "solid-js";
import type { BranchRef } from "../../api/types.ts";
import { cn } from "../../lib/cn.ts";
import { createReactiveListener } from "../../lib/lifecycle.ts";
import { Icons, Spinner } from "../../ui/index.ts";
import { resolveRefSelectorKey } from "./ref-selector-a11y.ts";

/**
 * Filterable WAI-ARIA branch combobox (`role="combobox"` + `role="listbox"`).
 *
 * Allows both free-text typing (preserving arbitrary branch names, PR draft
 * recovery, and resilience when the branch list fails to load) and one-click /
 * keyboard selection from the repository's branch list with full IME safety.
 */
export function BranchCombobox(props: {
  id?: string;
  name?: string;
  value: string;
  onInput: (value: string) => void;
  branches: readonly BranchRef[];
  defaultBranch?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  listboxLabel?: string;
  class?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const fallbackId = createUniqueId();
  const listId = createUniqueId();
  let root: HTMLDivElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const resolvedId = () => props.id ?? fallbackId;
  const optionId = (index: number) => `${listId}-opt-${index}`;

  const filtered = createMemo(() => {
    if (!typed()) return props.branches;
    const q = props.value.trim().toLowerCase();
    if (!q) return props.branches;
    return props.branches.filter((b) => b.name.toLowerCase().includes(q));
  });

  createEffect(() => {
    const list = filtered();
    if (!open() || list.length === 0) {
      setActiveIndex(-1);
      return;
    }
    if (activeIndex() >= list.length) {
      setActiveIndex(list.length - 1);
    }
  });

  const close = () => {
    setOpen(false);
    setTyped(false);
    setActiveIndex(-1);
  };

  const openList = () => {
    if (props.disabled) return;
    setTyped(false);
    setOpen(true);
  };

  const pick = (name: string) => {
    props.onInput(name);
    close();
    inputEl?.focus();
  };

  const scrollOptionIntoView = (index: number) => {
    const target = listEl?.querySelector<HTMLElement>(`[data-branch-index="${index}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
  };

  const onDocClick = (e: MouseEvent) => {
    if (!root) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (path.includes(root) || root.contains(e.target as Node)) return;
    close();
  };

  createReactiveListener({
    active: open,
    target: document,
    type: "click",
    handler: onDocClick as EventListener,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      if (open()) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    if (!open() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      if (props.branches.length > 0 || props.loading || props.error) {
        e.preventDefault();
        openList();
        if (filtered().length > 0) {
          setActiveIndex(e.key === "ArrowUp" ? filtered().length - 1 : 0);
        }
      }
      return;
    }
    if (!open()) return;
    const list = filtered();
    const action = resolveRefSelectorKey(e, list.length, activeIndex(), "input");
    if (action.type === "move" && action.index !== undefined) {
      e.preventDefault();
      setActiveIndex(action.index);
      scrollOptionIntoView(action.index);
      return;
    }
    if (action.type === "pick" && action.index !== undefined) {
      const chosen = list[action.index];
      if (chosen) {
        e.preventDefault();
        pick(chosen.name);
      }
    }
  };

  const activeDescendant = () => {
    const idx = activeIndex();
    return open() && idx >= 0 && idx < filtered().length ? optionId(idx) : undefined;
  };

  return (
    <div
      ref={root}
      class={cn("relative", props.class)}
      onFocusOut={(e) => {
        if (!open() || !root) return;
        const next = e.relatedTarget as Node | null;
        if (next && !root.contains(next)) close();
      }}
    >
      <div class="relative flex items-center">
        <input
          ref={inputEl}
          id={resolvedId()}
          name={props.name}
          type="text"
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-expanded={open()}
          aria-controls={open() ? listId : undefined}
          aria-activedescendant={activeDescendant()}
          disabled={props.disabled}
          required={props.required}
          value={props.value}
          placeholder={props.placeholder}
          onFocus={openList}
          onInput={(e) => {
            setTyped(true);
            props.onInput(e.currentTarget.value);
            if (!open()) setOpen(true);
            setActiveIndex(-1);
          }}
          on:keydown={onKeyDown}
          class="tg-focus min-h-11 w-full rounded-md border border-border bg-canvas py-1.5 pl-3 pr-11 font-mono text-sm text-fg placeholder:font-sans placeholder:text-subtle disabled:opacity-60 sm:min-h-0 sm:pr-8"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={props.disabled}
          aria-label={`Toggle ${props.listboxLabel ?? "branches"}`}
          class="tg-focus absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-r-md text-muted hover:text-fg disabled:opacity-60 sm:h-8 sm:w-8"
          onClick={(e) => {
            e.stopPropagation();
            if (open()) close();
            else {
              openList();
              inputEl?.focus();
            }
          }}
        >
          <Icons.ChevronDown class={cn("h-4 w-4 transition-transform", open() && "rotate-180")} />
        </button>
      </div>

      <Show when={open()}>
        <div
          ref={listEl}
          id={listId}
          role="listbox"
          aria-label={props.listboxLabel ?? "Branches"}
          class="absolute left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-canvas py-1 shadow-lg"
        >
          <Show
            when={!props.loading || props.branches.length > 0}
            fallback={
              <div class="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted">
                <Spinner size={14} /> Loading branches…
              </div>
            }
          >
            <Show
              when={!props.error}
              fallback={
                <div class="space-y-2 px-3 py-3 text-center text-xs text-danger">
                  <p>{props.error}</p>
                  <Show when={props.onRetry}>
                    <button
                      type="button"
                      class="tg-focus inline-flex min-h-11 items-center rounded-md border border-border bg-canvas-subtle px-3 py-1 text-xs font-medium text-fg hover:bg-canvas-inset sm:min-h-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onRetry?.();
                      }}
                    >
                      Retry
                    </button>
                  </Show>
                </div>
              }
            >
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="px-3 py-3 text-center text-xs text-muted">
                    {props.branches.length === 0 ? "No branches found." : "No matching branches."}
                  </div>
                }
              >
                <For each={filtered()}>
                  {(branch, index) => {
                    const selected = () => branch.name === props.value.trim();
                    const highlighted = () => activeIndex() === index();
                    const isDefault = () =>
                      branch.default || (props.defaultBranch !== undefined && branch.name === props.defaultBranch);
                    return (
                      <button
                        type="button"
                        id={optionId(index())}
                        data-branch-index={index()}
                        role="option"
                        aria-selected={selected()}
                        class={cn(
                          "tg-focus flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle sm:min-h-0",
                          selected() ? "font-semibold text-fg" : "text-fg",
                          highlighted() && "bg-canvas-subtle ring-1 ring-inset ring-accent-emphasis/60",
                        )}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index())}
                        onClick={() => pick(branch.name)}
                      >
                        <Icons.Check class={cn("h-4 w-4 shrink-0", selected() ? "text-success" : "text-transparent")} />
                        <span class="truncate font-mono">{branch.name}</span>
                        <Show when={isDefault()}>
                          <span class="ml-auto shrink-0 rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-muted">
                            default
                          </span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
