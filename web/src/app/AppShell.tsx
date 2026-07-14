import {
  createEffect,
  ErrorBoundary,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { useIsRouting, useLocation } from "@solidjs/router";
import { SessionProvider } from "../store/session.tsx";
import { TopBar } from "./TopBar.tsx";
import { Footer } from "./Footer.tsx";
import { RouteError } from "./RouteError.tsx";
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
  createEffect(() => {
    // Subscribe to path changes; clear a live error state when the user navigates.
    location.pathname;
    resetBoundary?.();
    resetBoundary = undefined;
  });
  return (
    <SessionProvider>
      <div class="flex min-h-screen flex-col bg-canvas text-fg">
        <Show when={isRouting()}>
          <div class="tg-route-bar" role="progressbar" aria-label="Loading page" />
        </Show>
        <TopBar />
        <main class="flex-1">
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
