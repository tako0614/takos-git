import { Show, type JSX } from "solid-js";
import { absoluteTime, relativeTime } from "../lib/time.ts";

/**
 * Renders an epoch-ms instant as relative text ("3 hours ago") with the
 * absolute time in the title. `epochMs` is the contract convention everywhere.
 */
export function RelativeTime(props: {
  epochMs: number | null | undefined;
  class?: string;
}): JSX.Element {
  const validMs = (): number | null => {
    const ms = props.epochMs;
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  };
  return (
    <Show
      when={validMs() !== null}
      fallback={<span class={props.class}>—</span>}
    >
      <time
        class={props.class}
        datetime={new Date(validMs() as number).toISOString()}
        title={absoluteTime(validMs() as number)}
      >
        {relativeTime(validMs() as number)}
      </time>
    </Show>
  );
}
