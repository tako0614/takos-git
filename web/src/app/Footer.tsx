import { type JSX } from "solid-js";

/** A quiet global footer. takos-git is a standalone installable Capsule. */
export function Footer(): JSX.Element {
  return (
    <footer class="mt-auto border-t border-border">
      <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted">
        <span>Takos Git — collaborative Git hosting Capsule.</span>
        <span class="flex items-center gap-3">
          <a href="/healthz" class="hover:text-fg">Status</a>
          <a href="/mcp" class="hover:text-fg">MCP</a>
        </span>
      </div>
    </footer>
  );
}
