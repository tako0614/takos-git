import { Show, type JSX } from "solid-js";
import { ApiError } from "../api/client.ts";
import { useSession } from "../store/session.tsx";
import { Icons } from "../lib/Icons.tsx";
import { Button, ButtonLink, EmptyState } from "../ui/index.ts";
import { PageContainer } from "./AppShell.tsx";

/**
 * The ErrorBoundary fallback for any route whose data resource rejected. Turns an
 * ApiError into a GitHub-like status page (404 not found / 403 no access / 401
 * sign in / other), instead of an infinite spinner. `reset` re-runs the failed
 * subtree (also fired automatically by AppShell on the next navigation).
 */
export function RouteError(props: {
  error: unknown;
  reset: () => void;
}): JSX.Element {
  const session = useSession();
  const api = (): ApiError | null =>
    props.error instanceof ApiError ? props.error : null;

  const title = (): string => {
    const e = api();
    if (!e) return "Something went wrong";
    if (e.status === 404) return "Not found";
    if (e.status === 403) return "You don’t have access";
    if (e.status === 401) return "Sign in required";
    return "Request failed";
  };

  const description = (): string => {
    const e = api();
    if (e?.status === 404) {
      return "This repository, page, or object does not exist, or is private and not visible to you.";
    }
    if (e?.status === 403) {
      return "You are signed in but do not have permission to view this.";
    }
    if (e?.status === 401) {
      return "This page requires you to be signed in.";
    }
    if (e) return e.message;
    return props.error instanceof Error
      ? props.error.message
      : "An unexpected error occurred.";
  };

  const canSignIn = (): boolean =>
    api()?.status === 401 && !session.authenticated() && session.configured();

  return (
    <PageContainer>
      <EmptyState
        icon={<Icons.AlertTriangle class="h-8 w-8" />}
        title={title()}
        description={description()}
        action={
          <div class="flex flex-wrap items-center justify-center gap-2">
            <Show when={canSignIn()}>
              <Button variant="primary" onClick={() => session.signIn()}>
                Sign in
              </Button>
            </Show>
            <Button variant="default" onClick={() => props.reset()}>
              Try again
            </Button>
            <ButtonLink href="/">Go home</ButtonLink>
          </div>
        }
      />
    </PageContainer>
  );
}
