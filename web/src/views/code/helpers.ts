/**
 * Pure helpers for the code-browser view family: URL building, blob decoding,
 * binary/image classification, README discovery, size formatting, and commit
 * grouping. Kept free of SolidJS so they can be unit-reasoned and reused across
 * the overview / tree / blob / commit / compare screens.
 */
import type { TreeEntry } from "../../api/types.ts";

/** `/owner/repo`. */
export function repoBase(owner: string, repo: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Encode a repo-relative path preserving `/` separators. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** A single ref segment (branch/tag) may contain slashes → keep it one segment. */
function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

export function treeHref(owner: string, repo: string, ref: string, path = ""): string {
  const p = encodePath(path);
  return `${repoBase(owner, repo)}/tree/${encodeRef(ref)}${p ? `/${p}` : ""}`;
}

export function blobHref(owner: string, repo: string, ref: string, path: string): string {
  return `${repoBase(owner, repo)}/blob/${encodeRef(ref)}/${encodePath(path)}`;
}

export function commitsHref(owner: string, repo: string, ref: string): string {
  return `${repoBase(owner, repo)}/commits/${encodeRef(ref)}`;
}

export function commitHref(owner: string, repo: string, sha: string): string {
  return `${repoBase(owner, repo)}/commit/${encodeURIComponent(sha)}`;
}

export function compareHref(owner: string, repo: string, spec: string): string {
  return `${repoBase(owner, repo)}/compare/${spec}`;
}

/** Parent path of a repo-relative path (`a/b/c` → `a/b`, `a` → ``). */
export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** Breadcrumb crumbs from a path, each with its accumulated path. */
export function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  const crumbs: Array<{ name: string; path: string }> = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/** Directory-first, case-insensitive name sort. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "tree";
    const bDir = b.kind === "tree";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif", "bmp"]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImagePath(name: string): boolean {
  return IMAGE_EXT.has(extOf(name));
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Best-effort MIME type from a file name (used for image data: URIs). */
export function mimeForName(name: string): string {
  return MIME[extOf(name)] ?? "application/octet-stream";
}

/** Decode a UTF-8 base64 payload (blob `encoding === "base64"`). */
export function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** Heuristic: does the decoded text look binary (contains a NUL byte)? */
export function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Human byte size, GitHub-ish. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

const README_RE = /^readme(\.(md|markdown|mdown|txt|rst))?$/i;

/** Find the root README blob entry, if any (prefers markdown). */
export function findReadme(entries: readonly TreeEntry[]): TreeEntry | undefined {
  const blobs = entries.filter((e) => e.kind === "blob" && README_RE.test(e.name));
  if (blobs.length === 0) return undefined;
  return (
    blobs.find((e) => /\.(md|markdown|mdown)$/i.test(e.name)) ??
    blobs.find((e) => /\.txt$/i.test(e.name)) ??
    blobs[0]
  );
}

/** Line count of a text blob (for the blob header). */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  let n = 1;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

/** Title of a commit message (first non-empty line). */
export function commitTitle(message: string): string {
  return message.split("\n")[0]?.trim() || "(no commit message)";
}

/** Body of a commit message (everything after the first line, trimmed). */
export function commitBody(message: string): string {
  const idx = message.indexOf("\n");
  if (idx < 0) return "";
  return message.slice(idx + 1).replace(/^\n+/, "").replace(/\s+$/, "");
}

/** Day bucket key for grouping commits ("Jul 14, 2026"). */
export function dayKey(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Group commits by author-date day, preserving order. */
export function groupByDay<T extends { author: { date: number } }>(
  commits: readonly T[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const commit of commits) {
    const key = dayKey(commit.author.date);
    const bucket = groups.get(key);
    if (bucket) bucket.push(commit);
    else groups.set(key, [commit]);
  }
  return Array.from(groups.entries());
}
