import { createResource, ErrorBoundary, Show, Suspense, type JSX } from "solid-js";
import { ApiError } from "../api/client.ts";
import { Spinner } from "../ui/index.ts";

/**
 * A tiny live-API probe used by placeholder views: runs `fetcher` and renders a
 * one-line result (`render`) or a friendly error, proving the api-client seam is
 * wired end-to-end against the running worker.
 */
export function Probe<T>(props: {
  label: string;
  fetcher: () => Promise<T>;
  render: (value: T) => JSX.Element;
}): JSX.Element {
  const [data] = createResource(props.fetcher);
  return (
    <div class="flex items-center gap-2 text-sm">
      <span class="text-muted">{props.label}:</span>
      <ErrorBoundary
        fallback={(err) => (
          <span class="text-attention">
            {err instanceof ApiError ? `${err.status} ${err.code}` : "unavailable"}
          </span>
        )}
      >
        <Suspense fallback={<Spinner size={14} />}>
          <Show when={data.state === "ready"}>
            <span class="font-semibold text-fg">{props.render(data() as T)}</span>
          </Show>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
