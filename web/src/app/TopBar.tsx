import { Show, createSignal, createUniqueId, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { useSession } from "../store/session.tsx";
import { Icons } from "../lib/Icons.tsx";
import { Avatar, IconButton, Menu, Spinner, useToast } from "../ui/index.ts";
import { resolvedTheme, setThemePref } from "../lib/theme.ts";

/** The product mark — a small git-fork glyph + wordmark, links home. */
function ProductMark(): JSX.Element {
  return (
    <A
      href="/"
      class="tg-focus flex min-h-11 items-center gap-2 rounded-md px-1 sm:min-h-0 sm:px-0"
      aria-label="Takos Git home"
    >
      <img src="/icons/takos-git.svg" alt="" class="h-6 w-6" />
      <span class="hidden text-sm font-semibold text-fg sm:inline">Takos Git</span>
    </A>
  );
}

/**
 * Global "jump to" search seam. Full code/repo search is a Phase-4b/M3 surface;
 * for now this navigates to `owner/repo` when the query looks like one, which
 * makes the box genuinely useful without a search backend.
 */
function GlobalSearchForm(props: {
  id?: string;
  class?: string;
  inputRef?: (el: HTMLInputElement) => void;
  onSubmitted?: () => void;
  onDismissEmpty?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const [value, setValue] = createSignal("");
  let inputEl: HTMLInputElement | undefined;
  return (
    <form
      id={props.id}
      class={props.class}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value().trim().replace(/^\/+/, "");
        if (!q) return;
        if (/^[^/\s]+\/[^/\s]+$/.test(q)) {
          navigate(`/${q}`);
          props.onSubmitted?.();
        } else {
          toast.info("Enter a repository path as owner/repo to jump directly.");
        }
      }}
    >
      <div class="relative block max-w-md">
        <Icons.Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input
          ref={(el) => {
            inputEl = el;
            props.inputRef?.(el);
          }}
          name="globalJump"
          type="search"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.isComposing || e.keyCode === 229) {
              if (e.key === "Enter") e.preventDefault();
              return;
            }
            if (e.key === "Escape") {
              if (value()) {
                e.preventDefault();
                setValue("");
              } else if (props.onDismissEmpty) {
                e.preventDefault();
                props.onDismissEmpty();
              }
            }
          }}
          placeholder="Jump to owner/repo…"
          aria-label="Search or jump to a repository"
          class="tg-focus min-h-11 w-full rounded-md border border-border bg-canvas-subtle py-1.5 pl-8 pr-9 text-sm text-fg placeholder:text-subtle sm:min-h-0"
        />
        <Show when={value()}>
          <button
            type="button"
            aria-label="Clear search"
            class="tg-focus absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-canvas-inset hover:text-fg sm:h-6 sm:w-6"
            onClick={() => {
              setValue("");
              inputEl?.focus();
            }}
          >
            <Icons.X class="h-3.5 w-3.5" />
          </button>
        </Show>
      </div>
    </form>
  );
}

function ThemeToggle(): JSX.Element {
  const isDark = () => resolvedTheme() === "dark";
  return (
    <IconButton
      aria-label={isDark() ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setThemePref(isDark() ? "light" : "dark")}
      title={`Theme: ${resolvedTheme()}`}
    >
      <Show when={isDark()} fallback={<Icons.Moon class="h-4 w-4" />}>
        <Icons.Sun class="h-4 w-4" />
      </Show>
    </IconButton>
  );
}

function SessionWidget(): JSX.Element {
  const session = useSession();
  const label = () => session.user()?.name ?? session.user()?.email ?? session.user()?.subject ?? "";
  return (
    <Show
      when={!session.loading()}
      fallback={<Spinner />}
    >
      <Show
        when={session.authenticated()}
        fallback={
          <Show
            when={session.configured()}
            fallback={<span class="text-xs text-muted">Sign-in unavailable</span>}
          >
            <button
              type="button"
              class="tg-focus inline-flex min-h-11 items-center rounded-md border border-border bg-canvas-subtle px-3 py-1.5 text-sm font-medium hover:bg-canvas-inset sm:min-h-0"
              onClick={() => session.signIn()}
            >
              Sign in
            </button>
          </Show>
        }
      >
        <Menu
          triggerLabel="Account menu"
          trigger={
            <span class="inline-flex h-11 w-11 items-center justify-center sm:h-8 sm:w-8">
              <Avatar name={label() || "user"} size={26} />
            </span>
          }
          items={[
            { label: <span class="text-muted">{label()}</span>, disabled: true },
            { label: "Your repositories", href: "/", separated: true },
            { label: "Sign out", danger: true, onSelect: () => void session.signOut(), separated: true },
          ]}
        />
      </Show>
    </Show>
  );
}

/** The global top bar: mark · search · theme · session. */
export function TopBar(): JSX.Element {
  const [mobileSearchOpen, setMobileSearchOpen] = createSignal(false);
  const mobileSearchId = createUniqueId();
  let mobileToggleBtn: HTMLButtonElement | undefined;
  let mobileInputEl: HTMLInputElement | undefined;

  const toggleMobileSearch = () => {
    if (mobileSearchOpen()) {
      setMobileSearchOpen(false);
      return;
    }
    setMobileSearchOpen(true);
    queueMicrotask(() => mobileInputEl?.focus());
  };

  return (
    <header class="sticky top-0 z-30 border-b border-border bg-canvas/95 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <ProductMark />
        <GlobalSearchForm class="hidden min-w-0 flex-1 sm:block" />
        <div class="ml-auto flex items-center gap-1 sm:gap-2">
          <IconButton
            ref={mobileToggleBtn}
            class="sm:hidden"
            aria-label={mobileSearchOpen() ? "Close repository search" : "Jump to repository"}
            aria-expanded={mobileSearchOpen()}
            aria-controls={mobileSearchOpen() ? mobileSearchId : undefined}
            onClick={toggleMobileSearch}
          >
            <Show when={mobileSearchOpen()} fallback={<Icons.Search class="h-4 w-4" />}>
              <Icons.X class="h-4 w-4" />
            </Show>
          </IconButton>
          <ThemeToggle />
          <SessionWidget />
        </div>
      </div>
      <Show when={mobileSearchOpen()}>
        <div class="border-t border-border bg-canvas px-4 py-2 sm:hidden">
          <GlobalSearchForm
            id={mobileSearchId}
            class="w-full"
            inputRef={(el) => {
              mobileInputEl = el;
            }}
            onSubmitted={() => setMobileSearchOpen(false)}
            onDismissEmpty={() => {
              setMobileSearchOpen(false);
              mobileToggleBtn?.focus();
            }}
          />
        </div>
      </Show>
    </header>
  );
}
