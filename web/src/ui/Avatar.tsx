import { createMemo, splitProps, type JSX } from "solid-js";
import { cn } from "../lib/cn.ts";

const PALETTE = [
  "#e11d48", "#db2777", "#9333ea", "#6366f1", "#2563eb",
  "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626",
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s/@._-]+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export interface AvatarProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Display name / login used for initials + deterministic color. */
  name: string;
  src?: string | null;
  size?: number;
  square?: boolean;
}

/**
 * A deterministic initials avatar (no external image host — CSP-safe). Renders
 * a same-origin `src` when provided; otherwise a colored initials tile.
 */
export function Avatar(props: AvatarProps): JSX.Element {
  const [local, rest] = splitProps(props, ["name", "src", "size", "square", "class", "style"]);
  const size = () => local.size ?? 20;
  const bg = createMemo(() => PALETTE[hash(local.name || "?") % PALETTE.length]);
  return (
    <span
      class={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden text-white font-medium leading-none",
        local.square ? "rounded" : "rounded-full",
        local.class,
      )}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        "font-size": `${Math.max(9, Math.round(size() * 0.42))}px`,
        background: local.src ? "transparent" : bg(),
        ...(typeof local.style === "object" ? local.style : {}),
      }}
      title={local.name}
      {...rest}
    >
      {local.src ? (
        <img src={local.src} alt="" class="h-full w-full object-cover" />
      ) : (
        initials(local.name)
      )}
    </span>
  );
}
