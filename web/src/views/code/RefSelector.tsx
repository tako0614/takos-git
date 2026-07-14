import {
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { reposApi } from "../../api/repos.ts";
import { Icons, Spinner } from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";

type RefKind = "branch" | "tag";

/**
 * GitHub-style branch/tag switcher. A filterable popover with Branches / Tags
 * tabs. Lazily loads refs the first time it is opened; `onPick` hands the chosen
 * ref back to the parent (which navigates). Closes on outside-click / Escape.
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
  let root: HTMLDivElement | undefined;
  let inputEl: HTMLInputElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    setOpen(false);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
  const toggle = () => {
    if (open()) {
      close();
      return;
    }
    setOpen(true);
    setFilter("");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => inputEl?.focus());
  };
  onCleanup(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

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
    const data = refs();
    const list = tab() === "branch" ? data?.branches ?? [] : data?.tags ?? [];
    const q = filter().trim().toLowerCase();
    return q ? list.filter((name) => name.toLowerCase().includes(q)) : list;
  };

  const pick = (name: string) => {
    close();
    props.onPick(name, tab());
  };

  const btnSize = () => (props.size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm");

  return (
    <div ref={root} class="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
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
          role="menu"
          class="absolute left-0 z-40 mt-1 w-72 overflow-hidden rounded-md border border-border bg-canvas shadow-lg"
        >
          <div class="border-b border-border p-2">
            <div class="text-xs font-semibold text-muted">Switch branches/tags</div>
            <div class="relative mt-2">
              <Icons.Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                ref={inputEl}
                type="text"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder={tab() === "branch" ? "Find a branch…" : "Find a tag…"}
                aria-label="Filter refs"
                class="tg-focus w-full rounded-md border border-border bg-canvas py-1.5 pl-7 pr-2 text-sm text-fg placeholder:text-subtle"
              />
            </div>
          </div>

          <div class="flex border-b border-border text-sm" role="tablist" aria-label="Ref kind">
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "branch"}
              class={cn(
                "flex-1 px-3 py-2 font-medium",
                tab() === "branch" ? "border-b-2 border-attention text-fg" : "text-muted hover:text-fg",
              )}
              onClick={() => setTab("branch")}
            >
              Branches
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab() === "tag"}
              class={cn(
                "flex-1 px-3 py-2 font-medium",
                tab() === "tag" ? "border-b-2 border-attention text-fg" : "text-muted hover:text-fg",
              )}
              onClick={() => setTab("tag")}
            >
              Tags
            </button>
          </div>

          <div class="max-h-64 overflow-y-auto py-1">
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
                  {(name) => {
                    const active = name === props.currentRef;
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        class={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas-subtle",
                          active ? "font-semibold text-fg" : "text-fg",
                        )}
                        onClick={() => pick(name)}
                      >
                        <Icons.Check class={cn("h-4 w-4 shrink-0", active ? "text-success" : "text-transparent")} />
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
