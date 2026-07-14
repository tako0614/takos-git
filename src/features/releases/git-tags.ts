/**
 * Tag-object helpers for the releases feature.
 *
 * Tags are refs in the authoritative R2 refs doc (`refs/tags/<name>`), never a D1
 * source of truth. A LIGHTWEIGHT tag is a ref pointing straight at a commit. An
 * ANNOTATED tag additionally has a git `tag` object (author + message) stored in
 * R2; the ref points at that tag object, and the D1 `git_tags` row caches the
 * annotation metadata for listing (a rebuildable projection of R2).
 *
 * These helpers build/peel tag objects with the same pure R2 primitives the rest
 * of the git layer uses — no D1, no ref writes (ref mutation goes through
 * two-phase in `service.ts`).
 */

import { getObject, putObject } from "../../git/object-store.ts";
import { isValidSha } from "../../git/git-objects.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";

export interface TagSignature {
  readonly name: string;
  readonly email: string;
  /** Epoch SECONDS (git signature convention). */
  readonly timestamp: number;
  readonly tzOffset: string;
}

export interface AnnotatedTagInput {
  readonly targetSha: string;
  readonly targetType: "commit" | "tree" | "blob" | "tag";
  readonly tagName: string;
  readonly tagger: TagSignature;
  readonly message: string;
}

export interface ParsedTagObject {
  readonly targetSha: string;
  readonly targetType: string;
  readonly tagName: string;
  readonly tagger: TagSignature | null;
  readonly message: string;
}

const MAX_TAG_BYTES = 64 * 1024;
const MAX_PEEL_DEPTH = 10;

function encodeTagContent(input: AnnotatedTagInput): Uint8Array {
  const t = input.tagger;
  const header =
    `object ${input.targetSha}\n` +
    `type ${input.targetType}\n` +
    `tag ${input.tagName}\n` +
    `tagger ${t.name} <${t.email}> ${t.timestamp} ${t.tzOffset}\n`;
  const body = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  return new TextEncoder().encode(`${header}\n${body}`);
}

/** Write an annotated tag object to R2 and return its SHA (the ref target). */
export async function writeAnnotatedTag(
  store: ObjectStoreBinding,
  input: AnnotatedTagInput,
): Promise<string> {
  return putObject(store, "tag", encodeTagContent(input));
}

/** Parse a git tag object's decoded content bytes. */
export function parseTagObject(content: Uint8Array): ParsedTagObject | null {
  const text = new TextDecoder().decode(content);
  const separator = text.indexOf("\n\n");
  const headerPart = separator === -1 ? text : text.slice(0, separator);
  const message = separator === -1 ? "" : text.slice(separator + 2);
  let targetSha = "";
  let targetType = "";
  let tagName = "";
  let tagger: TagSignature | null = null;
  for (const line of headerPart.split("\n")) {
    if (line.startsWith("object ")) targetSha = line.slice(7).trim();
    else if (line.startsWith("type ")) targetType = line.slice(5).trim();
    else if (line.startsWith("tag ")) tagName = line.slice(4).trim();
    else if (line.startsWith("tagger ")) tagger = parseSignature(line.slice(7));
  }
  if (!isValidSha(targetSha)) return null;
  return { targetSha, targetType, tagName, tagger, message };
}

function parseSignature(raw: string): TagSignature | null {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/u.exec(raw.trim());
  if (!match) return null;
  return {
    name: match[1],
    email: match[2],
    timestamp: Number.parseInt(match[3], 10),
    tzOffset: match[4],
  };
}

/**
 * Follow a ref target through any annotated tag objects down to the underlying
 * commit SHA. Returns null if the chain dead-ends at a missing object or a
 * non-commit terminal object.
 */
export async function peelToCommit(
  store: ObjectStoreBinding,
  sha: string,
): Promise<string | null> {
  let current = sha;
  for (let depth = 0; depth < MAX_PEEL_DEPTH; depth += 1) {
    if (!isValidSha(current)) return null;
    const object = await getObject(store, current, MAX_TAG_BYTES);
    if (!object) return null;
    if (object.type === "commit") return current;
    if (object.type !== "tag") return null;
    const parsed = parseTagObject(object.content);
    if (!parsed) return null;
    current = parsed.targetSha;
  }
  return null;
}
