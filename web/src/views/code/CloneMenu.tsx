import { createEffect, createSignal, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { computeHorizontalShift, viewportWidth } from "../../lib/floating-clamp.ts";
import { createReactiveListener } from "../../lib/lifecycle.ts";
import { Icons } from "../../ui/index.ts";
import { CopyButton } from "./CopyButton.tsx";

/**
 * The GitHub green "Code ▾" clone dropdown. Shows the HTTPS clone URL with a
 * copy affordance and a ready-to-paste `git clone` command. Read-only — no
 * SSH/CLI download variants (takos-git serves smart-HTTP clone only).
 */
export function CloneMenu(props: { cloneUrl: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [shiftX, setShiftX] = createSignal(0);
  const menuId = createUniqueId();
  const cloneUrlId = createUniqueId();
  let root: HTMLDivElement | undefined;
  let triggerBtn: HTMLButtonElement | undefined;
  let dialogEl: HTMLDivElement | undefined;
  let urlInputEl: HTMLInputElement | undefined;

  const updateShift = () => {
    if (!dialogEl || typeof window === "undefined") return;
    const prev = shiftX();
    const rect = dialogEl.getBoundingClientRect();
    const unshifted = { left: rect.left - prev, right: rect.right - prev };
    setShiftX(computeHorizontalShift(unshifted, viewportWidth()));
  };

  createEffect(() => {
    if (!open()) {
      setShiftX(0);
      return;
    }
    const frame = requestAnimationFrame(updateShift);
    onCleanup(() => cancelAnimationFrame(frame));
  });
  if (typeof window !== "undefined") {
    createReactiveListener({
      active: open,
      target: window,
      type: "resize",
      handler: updateShift as EventListener,
    });
  }

  const onDocClick = (e: MouseEvent) => {
    if (!root) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (path.includes(root) || root.contains(e.target as Node)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerBtn?.focus();
    }
  };
  const close = () => {
    setOpen(false);
  };
  const toggle = () => {
    if (open()) {
      close();
      return;
    }
    setOpen(true);
    queueMicrotask(() => urlInputEl?.focus());
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

  const cloneCmd = () => `git clone ${props.cloneUrl}`;

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
        class="tg-focus inline-flex min-h-11 items-center gap-1.5 rounded-md border border-success-emphasis bg-success-emphasis px-3 text-sm font-medium text-white hover:brightness-110 sm:min-h-0 sm:h-8"
        onClick={toggle}
      >
        <Icons.Code class="h-4 w-4" />
        Code
        <Icons.ChevronDown class="h-4 w-4" />
      </button>

      <Show when={open()}>
        <div
          ref={dialogEl}
          id={menuId}
          role="dialog"
          aria-label="Clone repository"
          style={shiftX() ? { transform: `translateX(${shiftX()}px)` } : undefined}
          class="absolute right-0 z-40 mt-1 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-canvas p-3 shadow-lg"
        >
          <div class="flex items-center gap-2 text-sm font-semibold text-fg">
            <Icons.Terminal class="h-4 w-4 text-muted" /> Clone
          </div>
          <p class="mt-1 text-xs text-muted">Clone over HTTPS with the git CLI.</p>

          <label class="mt-3 block text-xs font-medium text-muted" for={cloneUrlId}>
            HTTPS
          </label>
          <div class="mt-1 flex items-center gap-1 rounded-md border border-border bg-canvas-subtle">
            <input
              ref={urlInputEl}
              id={cloneUrlId}
              name="cloneUrl"
              type="text"
              readonly
              value={props.cloneUrl}
              class="tg-focus min-h-11 min-w-0 flex-1 rounded-l-md bg-transparent px-2 py-1.5 font-mono text-xs text-fg sm:min-h-0"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton
              value={props.cloneUrl}
              label="Clone URL"
              title="Copy clone URL"
              class="h-11 w-11 shrink-0 hover:bg-canvas-inset sm:h-8 sm:w-8"
            />
          </div>

          <div class="mt-3 flex items-center justify-between">
            <span class="text-xs font-medium text-muted">Command</span>
            <CopyButton
              value={cloneCmd()}
              label="Command"
              title="Copy git clone command"
              class="min-h-11 px-2 text-xs text-accent hover:underline sm:min-h-0 sm:px-0"
            >
              <span>Copy command</span>
            </CopyButton>
          </div>
          <pre class="mt-1 overflow-x-auto rounded-md border border-border bg-canvas-subtle p-2 font-mono text-xs text-fg">{cloneCmd()}</pre>
        </div>
      </Show>
    </div>
  );
}
