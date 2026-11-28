import { compareRouteSpec } from "./compare-route.ts";

export interface ParsedCompareSpec {
  readonly base: string;
  readonly head: string;
  readonly separator: "..." | "..";
}

/**
 * Split a raw route `*spec` (`base...head` or `base..head`) into its endpoints.
 * Tolerates empty specs (visiting `/compare` directly) and malformed escapes.
 */
export function parseCompareSpec(spec: string): ParsedCompareSpec {
  if (!spec) return { base: "", head: "", separator: "..." };
  let decoded: string;
  try {
    decoded = compareRouteSpec(spec);
  } catch {
    return { base: "", head: "", separator: "..." };
  }
  if (!decoded) return { base: "", head: "", separator: "..." };
  const separator: "..." | ".." = decoded.includes("...") ? "..." : "..";
  const idx = decoded.indexOf(separator);
  if (idx < 0) return { base: decoded, head: "", separator: "..." };
  return {
    base: decoded.slice(0, idx),
    head: decoded.slice(idx + separator.length),
    separator,
  };
}

/**
 * Encode a base/head pair into a route spec segment that `compareRouteSpec`
 * decodes back to literal `base...head` (including refs containing `/`).
 */
export function formatCompareSpec(
  base: string,
  head: string,
  separator: "..." | ".." = "...",
): string {
  return `${encodeURIComponent(base)}${separator}${encodeURIComponent(head)}`;
}
