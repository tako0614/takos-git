/**
 * Minimal className combiner. Accepts strings, falsy values (skipped), and
 * `[condition, className]` tuples. No dependency; not a Tailwind-merge — the
 * design system is written so utilities do not conflict.
 */
export type ClassValue =
  | string
  | false
  | null
  | undefined
  | [unknown, string];

export function cn(...parts: ClassValue[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") {
      if (part) out.push(part);
    } else if (part[0]) {
      out.push(part[1]);
    }
  }
  return out.join(" ");
}
