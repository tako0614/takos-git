import {
  createEffect,
  ErrorBoundary,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { useIsRouting, useLocation } from "@solidjs/router";
import { SessionProvider } from "../store/session.tsx";
import { TopBar } from "./TopBar.tsx";
import { Footer } from "./Footer.tsx";
import { RouteError } from "./RouteError.tsx";
import { applyDocumentTitle } from "../lib/document-title.ts";
import { ToastHost, ConfirmDialogHost, LoadingBlock } from "../ui/index.ts";

/**
 * The root layout wrapping every route (`<Router root={AppShell}>`). Provides
 * the session context, the top bar, the toast + confirm-dialog hosts, a footer,
 * and a route-transition progress bar. Lazy route bodies get a Suspense
 * fallback so navigating to an un-fetched view never blanks the shell; an
 * ErrorBoundary turns a rejected data resource (404/403/network) into a real
 * error page instead of an infinite spinner + uncaught rejection, and resets
 * itself on the next navigation so the shell stays usable.
 */
export function AppShell(props: { children?: JSX.Element }): JSX.Element {
  const isRouting = useIsRouting();
  const location = useLocation();
  let resetBoundary: (() => void) | undefined;
  let mainEl: HTMLElement | undefined;
  const initialTitle = typeof document !== "undefined" ? document.title : "";
  onCleanup(() => {
    if (typeof document !== "undefined") document.title = initialTitle;
  });
  createEffect(() => {
    // Subscribe to path changes; clear a live error state and update <title>.
    applyDocumentTitle(location.pathname);
    resetBoundary?.();
    resetBoundary = undefined;
  });
  return (
    <SessionProvider>
      <div class="flex min-h-screen flex-col bg-canvas text-fg">
        <a
          href="#main"
          class="tg-focus sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:bg-accent-emphasis focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
          onClick={(e) => {
            e.preventDefault();
            mainEl?.focus();
            mainEl?.scrollIntoView();
          }}
        >
          Skip to main content
        </a>
        <Show when={isRouting()}>
          <div class="tg-route-bar" role="progressbar" aria-label="Loading page" />
        </Show>
        <TopBar />
        <main id="main" tabIndex={-1} ref={mainEl} class="flex-1 outline-none">
          <ErrorBoundary
            fallback={(error, reset) => {
              resetBoundary = reset;
              return <RouteError error={error} reset={reset} />;
            }}
          >
            <Suspense fallback={<LoadingBlock class="py-24" label="Loading…" />}>
              {props.children}
            </Suspense>
          </ErrorBoundary>
        </main>
        <Footer />
        <ToastHost />
        <ConfirmDialogHost />
      </div>
    </SessionProvider>
  );
}

/** Standard page container width used by non-repo pages. */
export function PageContainer(props: { children: JSX.Element; class?: string }): JSX.Element {
  return (
    <div class={`mx-auto w-full max-w-7xl px-4 py-6 ${props.class ?? ""}`}>
      {props.children}
    </div>
  );
}
