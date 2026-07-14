import { Show, Suspense, type JSX } from "solid-js";
import { useIsRouting } from "@solidjs/router";
import { SessionProvider } from "../store/session.tsx";
import { TopBar } from "./TopBar.tsx";
import { Footer } from "./Footer.tsx";
import { ToastHost, ConfirmDialogHost, LoadingBlock } from "../ui/index.ts";

/**
 * The root layout wrapping every route (`<Router root={AppShell}>`). Provides
 * the session context, the top bar, the toast + confirm-dialog hosts, a footer,
 * and a route-transition progress bar. Lazy route bodies get a Suspense
 * fallback so navigating to an un-fetched view never blanks the shell.
 */
export function AppShell(props: { children?: JSX.Element }): JSX.Element {
  const isRouting = useIsRouting();
  return (
    <SessionProvider>
      <div class="flex min-h-screen flex-col bg-canvas text-fg">
        <Show when={isRouting()}>
          <div class="tg-route-bar" role="progressbar" aria-label="Loading page" />
        </Show>
        <TopBar />
        <main class="flex-1">
          <Suspense fallback={<LoadingBlock class="py-24" label="Loading…" />}>
            {props.children}
          </Suspense>
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
