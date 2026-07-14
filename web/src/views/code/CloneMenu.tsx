import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Icons } from "../../ui/index.ts";
import { CopyButton } from "./CopyButton.tsx";

/**
 * The GitHub green "Code ▾" clone dropdown. Shows the HTTPS clone URL with a
 * copy affordance and a ready-to-paste `git clone` command. Read-only — no
 * SSH/CLI download variants (takos-git serves smart-HTTP clone only).
 */
export function CloneMenu(props: { cloneUrl: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

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
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  };
  onCleanup(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  const cloneCmd = () => `git clone ${props.cloneUrl}`;

  return (
    <div ref={root} class="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        class="tg-focus inline-flex h-8 items-center gap-1.5 rounded-md border border-success-emphasis bg-success-emphasis px-3 text-sm font-medium text-white hover:brightness-110"
        onClick={toggle}
      >
        <Icons.Code class="h-4 w-4" />
        Code
        <Icons.ChevronDown class="h-4 w-4" />
      </button>

      <Show when={open()}>
        <div
          role="menu"
          class="absolute right-0 z-40 mt-1 w-80 overflow-hidden rounded-md border border-border bg-canvas p-3 shadow-lg"
        >
          <div class="flex items-center gap-2 text-sm font-semibold text-fg">
            <Icons.Terminal class="h-4 w-4 text-muted" /> Clone
          </div>
          <p class="mt-1 text-xs text-muted">Clone over HTTPS with the git CLI.</p>

          <label class="mt-3 block text-xs font-medium text-muted" for="clone-url">
            HTTPS
          </label>
          <div class="mt-1 flex items-center gap-1 rounded-md border border-border bg-canvas-subtle">
            <input
              id="clone-url"
              type="text"
              readonly
              value={props.cloneUrl}
              class="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-xs text-fg outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton
              value={props.cloneUrl}
              label="Clone URL"
              title="Copy clone URL"
              class="h-8 w-8 shrink-0 hover:bg-canvas-inset"
            />
          </div>

          <div class="mt-3 flex items-center justify-between">
            <span class="text-xs font-medium text-muted">Command</span>
            <CopyButton value={cloneCmd()} label="Command" title="Copy git clone command" class="text-xs text-accent hover:underline">
              <span>Copy command</span>
            </CopyButton>
          </div>
          <pre class="mt-1 overflow-x-auto rounded-md border border-border bg-canvas-subtle p-2 font-mono text-xs text-fg">{cloneCmd()}</pre>
        </div>
      </Show>
    </div>
  );
}
