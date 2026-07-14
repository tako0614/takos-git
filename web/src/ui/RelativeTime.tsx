import { type JSX } from "solid-js";
import { absoluteTime, relativeTime } from "../lib/time.ts";

/**
 * Renders an epoch-ms instant as relative text ("3 hours ago") with the
 * absolute time in the title. `epochMs` is the contract convention everywhere.
 */
export function RelativeTime(props: {
  epochMs: number | null | undefined;
  class?: string;
}): JSX.Element {
  if (props.epochMs == null) return <span class={props.class}>—</span>;
  const ms = props.epochMs;
  return (
    <time class={props.class} datetime={new Date(ms).toISOString()} title={absoluteTime(ms)}>
      {relativeTime(ms)}
    </time>
  );
}
