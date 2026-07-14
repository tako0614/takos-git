import { type JSX } from "solid-js";
import { PageContainer } from "../app/AppShell.tsx";
import { ButtonLink, EmptyState, Icons } from "../ui/index.ts";
import { A } from "@solidjs/router";

/** Client-side 404 for unmatched routes (the worker SPA fallback lands here). */
export function NotFoundView(): JSX.Element {
  return (
    <PageContainer>
      <EmptyState
        icon={<Icons.Search class="h-10 w-10" />}
        title="404 — Page not found"
        description="This page doesn’t exist. It may have been moved, or the URL may be mistyped."
        action={
          <ButtonLink as={A} href="/" variant="primary">
            Back to repositories
          </ButtonLink>
        }
      />
    </PageContainer>
  );
}
