function decodeSafe(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function normalizeNavPath(path: string): string {
  const clean = path.split(/[?#]/u, 1)[0] ?? "";
  const trimmed = clean.replace(/\/+$/u, "");
  return (trimmed || "/").toLowerCase();
}

export interface NavActiveItem {
  readonly href: string;
  readonly end?: boolean;
  readonly alsoActivePrefixes?: readonly string[];
}

/**
 * Determines whether an `UnderlineNav` tab matches the current pathname,
 * supporting both `end` exact-match and `alsoActivePrefixes` (e.g. `Code` tab
 * on `/blob/*`, `/tree/*`, `/commits/*`, `/commit/*`, `/compare/*`).
 */
export function isUnderlineNavItemActive(pathname: string, item: NavActiveItem): boolean {
  const loc = normalizeNavPath(decodeSafe(pathname));
  const target = normalizeNavPath(item.href);
  const direct = item.end ? loc === target : loc === target || loc.startsWith(`${target}/`);
  if (direct) return true;
  if (!item.alsoActivePrefixes?.length) return false;
  return item.alsoActivePrefixes.some((prefix) => {
    const normalized = normalizeNavPath(prefix);
    return loc === normalized || loc.startsWith(`${normalized}/`);
  });
}
