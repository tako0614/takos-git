import {
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { reposApi } from "../../api/repos.ts";
import { Icons, Spinner } from "../../ui/index.ts";
import { moveTabFocus } from "../../lib/a11y.ts";
import { cn } from "../../lib/cn.ts";
import { createReactiveListener } from "../../lib/lifecycle.ts";
import { resolveRefSelectorKey } from "./ref-selector-a11y.ts";

type RefKind = "branch" | "tag";

/**
 * GitHub-style branch/tag switcher. A filterable popover with Branches / Tags
 * tabs. Lazily loads refs the first time it is opened; `onPick` hands the chosen
 * ref back to the parent (which navigates). Supports Arrow/Home/End/Enter
 * keyboard selection and closes on outside-click, focus-out, or Escape.
 */
export function RefSelector(props: {
  owner: string;
  repo: string;
  currentRef: string;
  defaultBranch?: string;
  onPick: (ref: string, kind: RefKind) => void;
  size?: "sm" | "md";
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal<RefKind>("branch");
  const [filter, setFilter] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const menuId = createUniqueId();
  const listId = createUniqueId();
  let root: HTMLDivElement | undefined;
  let triggerBtn: HTMLButtonElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const optionId = (index: number) => `${listId}-opt-${index}`;

  const onDocClick = (e: MouseEvent) => {
    if (!root) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (path.includes(root) || root.contains(e.target as Node)) return;
    close();
  };
  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };
  const toggle = () => {
    if (open()) {
      close();
      return;
    }
    setOpen(true);
    setFilter("");
    setActiveIndex(-1);
    queueMicrotask(() => inputEl?.focus());
  };

  // Fetch only once the popover has been opened at least once.
  const [refs] = createResource(
    () => (open() ? ([props.owner, props.repo] as const) : false),
    async ([owner, repo]) => {
      const [branchList, tagPage] = await Promise.all([
        reposApi.branches(owner, repo).catch(() => ({ branches: [] as const })),
        reposApi.tags(owner, repo, { limit: 100 }).catch(() => ({ items: [] as const, nextCursor: null })),
      ]);
      return {
        branches: branchList.branches.map((b) => b.name),
        tags: tagPage.items.map((t) => t.name),
      };
    },
  );

  const items = () => {
    if (refs.error) return [];
    const data = refs();
    const list = tab() === "branch" ? data?.branches ?? [] : data?.tags ?? [];
    const q = filter().trim().toLowerCase();
    return q ? list.filter((name) => name.toLowerCase().includes(q)) : list;
  };

  createEffect(() => {
    const list = items();
    const q = filter().trim();
    if (!open()) {
      setActiveIndex(-1);
      return;
    }
    if (list.length === 0) {
      setActiveIndex(-1);
      return;
    }
    if (q) {
      setActiveIndex(0);
    } else if (activeIndex() >= list.length) {
      setActiveIndex(list.length - 1);
    }
  });

  const pick = (name: string) => {
    close();
    props.onPick(name, tab());
    triggerBtn?.focus();
  };

  const scrollOptionIntoView = (index: number) => {
    const target = listEl?.querySelector<HTMLElement>(`[data-ref-index="${index}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerBtn?.focus();
      return;
    }
    const list = items();
    const active = document.activeElement;
    const scope =
      active === inputEl
        ? "input"
        : active instanceof HTMLElement && Boolean(active.closest?.("[data-ref-index]"))
          ? "option"
          : "other";
    const action = resolveRefSelectorKey(e, list.length, activeIndex(), scope);
    if (action.type === "move" && action.index !== undefined) {
      e.preventDefault();
      setActiveIndex(action.index);
      scrollOptionIntoView(action.index);
      if (scope === "option") {
        listEl?.querySelector<HTMLElement>(`[data-ref-index="${action.index}"]`)?.focus();
      }
      return;
    }
    if (action.type === "pick" && action.index !== undefined) {
      const chosen = list[action.index];
      if (chosen) {
        e.preventDefault();
        pick(chosen);
      }
    }
  };

  createReactiveListener({
    active: open,
    target: document,
    type: "click",
    handler: onDocClick as EventListener,
  });
  createReactiveListener({
    active: open,
    target: document,
    type: "keydown",
    handler: onKey as EventListener,
  });

  const onTabKeyDown = (e: KeyboardEvent) => {
    const next = moveTabFocus(e);
    if (next === "branch" || next === "tag") {
      e.stopPropagation();
      setTab(next);
      setActiveIndex(-1);
    }
  };

  const activeDescendant = () => {
    const idx = activeIndex();
    return open() && idx >= 0 && idx < items().length ? optionId(idx) : undefined;
  };

  const btnSize = () =>
    props.size === "sm"
      ? "min-h-10 sm:min-h-0 sm:h-7 px-2.5 text-xs"
      : "min-h-11 sm:min-h-0 sm:h-8 px-3 text-sm";

  return (
    <div
      ref={root}
      class="relative inline-block text-left"
      onFocusOut={(e) => {
        if (!open() || !root) return;
        const next = e.relatedTarget as Node | null;
        if (next && !root.contains(next)) close();
      }}
    >
      <button
        ref={triggerBtn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={open() ? menuId : undefined}
        class={cn(
          "tg-focus inline-flex max-w-[15rem] items-center gap-1.5 rounded-md border border-border bg-canvas-subtle font-medium text-fg hover:bg-canvas-inset",
          btnSize(),
        )}
        onClick={toggle}
      >
        <Icons.GitBranch class="h-4 w-4 shrink-0 text-muted" />
        <span class="truncate font-mono">{props.currentRef}</span>
        <Icons.ChevronDown class="h-4 w-4 shrink-0 text-muted" />
      </button>

      <Show when={open()}>
        <div
          id={menuId}
          role="dialog"
          aria-label="Switch branches or tags"
          class="absolute left-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-canvas shadow-lg"
        >
          <div class="border-b border-border p-2">
            <div class="text-xs font-semibold text-muted">Switch branches/tags</div>
            <div class="relative mt-2">
              <Icons.Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                ref={inputEl}
                name="refFilter"
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open()}
                aria-controls={open() ? listId : undefined}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder={tab() === "branch" ? "Find a branch…" : "Find a tag…"}
                aria-label="Filter refs"
                aria-activedescendant={activeDescendant()}
                class="tg-focus w-full rounded-md border border-border bg-canvas py-1.5 pl-7 pr-8 text-sm text-fg placeholder:text-subtle"
              />
              <Show when={filter()}>
                <button
                  type="button"
                  aria-label="Clear ref filter"
                  class="tg-focus absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-canvas-subtle hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilter("");
                    setActiveIndex(-1);
                    inputEl?.focus();
                  }}
                >
                  <Icons.X class="h-3.5 w-3.5" />
                </button>
              </Show>
            </div>
          </div>

          <div class="flex border-b border-border text-sm" role="tablist" aria-label="Ref kind">
            <button
              type="button"
              role="tab"
              data-tab-id="branch"
              tabIndex={tab() === "branch" ? 0 : -1}
              aria-selected={tab() === "branch"}
              class={cn(
                "tg-focus min-h-10 flex-1 px-3 py-2 font-medium sm:min-h-0",
                tab() === "branch" ? "border-b-2 border-attention-emphasis text-fg" : "text-muted hover:text-fg",
              )}
              onClick={() => {
                setTab("branch");
                setActiveIndex(-1);
              }}
              onKeyDown={onTabKeyDown}
            >
              Branches
            </button>
            <button
              type="button"
              role="tab"
              data-tab-id="tag"
              tabIndex={tab() === "tag" ? 0 : -1}
              aria-selected={tab() === "tag"}
              class={cn(
                "tg-focus min-h-10 flex-1 px-3 py-2 font-medium sm:min-h-0",
                tab() === "tag" ? "border-b-2 border-attention-emphasis text-fg" : "text-muted hover:text-fg",
              )}
              onClick={() => {
                setTab("tag");
                setActiveIndex(-1);
              }}
              onKeyDown={onTabKeyDown}
            >
              Tags
            </button>
          </div>

          <div
            ref={listEl}
            id={listId}
            role="listbox"
            aria-label={tab() === "branch" ? "Branches" : "Tags"}
            class="max-h-64 overflow-y-auto py-1"
          >
            <Suspense fallback={<div class="flex justify-center py-6"><Spinner /></div>}>
              <Show
                when={items().length > 0}
                fallback={
                  <div class="px-3 py-6 text-center text-sm text-muted">
                    {tab() === "branch" ? "No branches found." : "No tags found."}
                  </div>
                }
              >
                <For each={items()}>
                  {(name, index) => {
                    const current = name === props.currentRef;
                    const highlighted = () => activeIndex() === index();
                    return (
                      <button
                        type="button"
                        id={optionId(index())}
                        data-ref-index={index()}
                        role="option"
                        aria-selected={current}
                        class={cn(
                          "tg-focus flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle sm:min-h-0",
                          current ? "font-semibold text-fg" : "text-fg",
                          highlighted() && "bg-canvas-subtle ring-1 ring-inset ring-accent-emphasis/60",
                        )}
                        onMouseEnter={() => setActiveIndex(index())}
                        onClick={() => pick(name)}
                      >
                        <Icons.Check class={cn("h-4 w-4 shrink-0", current ? "text-success" : "text-transparent")} />
                        <span class="truncate font-mono">{name}</span>
                        <Show when={name === props.defaultBranch}>
                          <span class="ml-auto rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-muted">
                            default
                          </span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </Suspense>
          </div>
        </div>
      </Show>
    </div>
  );
}
