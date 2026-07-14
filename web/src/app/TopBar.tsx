import { Show, createSignal, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { useSession } from "../store/session.tsx";
import { Icons } from "../lib/Icons.tsx";
import { Avatar, IconButton, Menu, Spinner } from "../ui/index.ts";
import { cycleTheme, resolvedTheme } from "../lib/theme.ts";

/** The product mark — a small git-fork glyph + wordmark, links home. */
function ProductMark(): JSX.Element {
  return (
    <A href="/" class="tg-focus flex items-center gap-2 rounded-md" aria-label="Takos Git home">
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
function GlobalSearch(): JSX.Element {
  const navigate = useNavigate();
  const [value, setValue] = createSignal("");
  return (
    <form
      class="hidden min-w-0 flex-1 sm:block"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value().trim().replace(/^\/+/, "");
        if (/^[^/\s]+\/[^/\s]+$/.test(q)) navigate(`/${q}`);
      }}
    >
      <label class="relative block max-w-md">
        <Icons.Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input
          type="search"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          placeholder="Jump to owner/repo…"
          aria-label="Search or jump to a repository"
          class="tg-focus w-full rounded-md border border-border bg-canvas-subtle py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-subtle"
        />
      </label>
    </form>
  );
}

function ThemeToggle(): JSX.Element {
  return (
    <IconButton
      aria-label="Toggle theme"
      onClick={() => cycleTheme()}
      title={`Theme: ${resolvedTheme()}`}
    >
      <Show when={resolvedTheme() === "dark"} fallback={<Icons.Eye class="h-4 w-4" />}>
        <Icons.EyeOff class="h-4 w-4" />
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
              class="tg-focus rounded-md border border-border bg-canvas-subtle px-3 py-1.5 text-sm font-medium hover:bg-canvas-inset"
              onClick={() => session.signIn()}
            >
              Sign in
            </button>
          </Show>
        }
      >
        <Menu
          triggerLabel="Account menu"
          trigger={<Avatar name={label() || "user"} size={26} />}
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
  return (
    <header class="sticky top-0 z-30 border-b border-border bg-canvas/95 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <ProductMark />
        <GlobalSearch />
        <div class="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <SessionWidget />
        </div>
      </div>
    </header>
  );
}
