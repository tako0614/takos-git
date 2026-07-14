import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Icons, useToast } from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";

/**
 * A small "copy to clipboard" affordance. Swaps to a check for ~1.5s and fires a
 * toast. Falls back gracefully when the clipboard API is unavailable.
 */
export function CopyButton(props: {
  value: string;
  label?: string;
  title?: string;
  class?: string;
  size?: number;
  children?: JSX.Element;
}): JSX.Element {
  const toast = useToast();
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      toast.success(props.label ? `${props.label} copied` : "Copied to clipboard");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed — your browser blocked clipboard access");
    }
  };

  const iconSize = () => props.size ?? 16;

  return (
    <button
      type="button"
      class={cn(
        "tg-focus inline-flex items-center justify-center gap-1.5 rounded-md",
        props.class,
      )}
      title={props.title ?? "Copy"}
      aria-label={props.title ?? props.label ?? "Copy to clipboard"}
      onClick={copy}
    >
      <Show
        when={copied()}
        fallback={<Icons.Copy class="text-muted" style={{ width: `${iconSize()}px`, height: `${iconSize()}px` }} />}
      >
        <Icons.Check class="text-success" style={{ width: `${iconSize()}px`, height: `${iconSize()}px` }} />
      </Show>
      {props.children}
    </button>
  );
}
