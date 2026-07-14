import { Show, type JSX } from "solid-js";
import { Button } from "./Button.tsx";
import { Icons } from "../lib/Icons.tsx";

/**
 * Cursor pagination controls. The API uses opaque `nextCursor` (no page
 * numbers), so this is a forward/back pair driven by a cursor stack the caller
 * keeps. Provide `onPrev` only when a previous cursor exists.
 */
export function Pagination(props: {
  hasNext: boolean;
  hasPrev?: boolean;
  onNext?: () => void;
  onPrev?: () => void;
  loading?: boolean;
  class?: string;
}): JSX.Element {
  return (
    <Show when={props.hasNext || props.hasPrev}>
      <div class={`flex items-center justify-center gap-2 py-4 ${props.class ?? ""}`}>
        <Button
          size="sm"
          disabled={!props.hasPrev || props.loading}
          onClick={() => props.onPrev?.()}
        >
          <Icons.ChevronLeft class="h-4 w-4" /> Previous
        </Button>
        <Button
          size="sm"
          disabled={!props.hasNext || props.loading}
          onClick={() => props.onNext?.()}
        >
          Next <Icons.ChevronRight class="h-4 w-4" />
        </Button>
      </div>
    </Show>
  );
}
