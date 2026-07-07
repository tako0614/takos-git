/**
 * Git Smart HTTP (v0/v1) read-only serve path — advertisement + upload-pack,
 * decoupled from any framework or auth. Protocol helpers are lifted from the
 * takos worker's `git-smart-http.ts`; refs come from the per-repo R2 ref store
 * and objects from the shared R2 object store.
 */

import type { ObjectStoreBinding } from "./git/types.ts";
import { writePackFromShas } from "./git/pack.ts";
import { parsePktLines, PKT_FLUSH, pktLineString } from "./git/pack-common.ts";
import { concatBytes } from "./git/sha1.ts";
import { readRepoRefs } from "./git/refs-store.ts";
import { collectReachableObjects } from "./git/reachability.ts";

const ZERO_OID = "0".repeat(40);
const AGENT = "agent=takos-git/0.1";

function bytesToBody(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface AdvertisedRefs {
  readonly lines: Array<{ sha: string; name: string }>;
  readonly tips: Set<string>;
  readonly headSymref: string | null;
}

async function advertisedRefs(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<AdvertisedRefs> {
  const doc = await readRepoRefs(bucket, repo);
  const lines: Array<{ sha: string; name: string }> = [];
  const tips = new Set<string>();
  let headSymref: string | null = null;

  if (doc.defaultBranch) {
    const headRefName = `refs/heads/${doc.defaultBranch}`;
    const headRef = doc.refs.find((ref) => ref.name === headRefName);
    if (headRef) {
      headSymref = headRefName;
      lines.push({ sha: headRef.sha, name: "HEAD" });
      tips.add(headRef.sha);
    }
  }
  for (const ref of doc.refs) {
    lines.push({ sha: ref.sha, name: ref.name });
    tips.add(ref.sha);
  }
  return { lines, tips, headSymref };
}

function buildAdvertisement(refs: AdvertisedRefs): Uint8Array {
  const capParts = [AGENT, "object-format=sha1"];
  if (refs.headSymref) capParts.unshift(`symref=HEAD:${refs.headSymref}`);
  const caps = capParts.join(" ");

  const parts: Uint8Array[] = [
    pktLineString("# service=git-upload-pack\n"),
    PKT_FLUSH,
  ];
  if (refs.lines.length === 0) {
    parts.push(pktLineString(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.lines.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps}` : "";
      parts.push(pktLineString(`${line.sha} ${line.name}${suffix}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return concatBytes(...parts);
}

function parseUploadPackRequest(body: Uint8Array): { wants: string[]; haves: string[] } {
  const wants: string[] = [];
  const haves: string[] = [];
  const decoder = new TextDecoder();
  for (const line of parsePktLines(body)) {
    if (!line.payload) continue;
    const text = decoder.decode(line.payload).trimEnd();
    if (text.startsWith("want ")) {
      const sha = text.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(sha)) wants.push(sha);
    } else if (text.startsWith("have ")) {
      const sha = text.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(sha)) haves.push(sha);
    }
  }
  return { wants, haves };
}

export async function handleInfoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<Response> {
  const refs = await advertisedRefs(bucket, repo);
  return new Response(bytesToBody(buildAdvertisement(refs)), {
    status: 200,
    headers: {
      "content-type": "application/x-git-upload-pack-advertisement",
      "cache-control": "no-cache",
    },
  });
}

export async function handleUploadPack(
  bucket: ObjectStoreBinding,
  repo: string,
  requestBody: Uint8Array,
): Promise<Response> {
  const { wants, haves } = parseUploadPackRequest(requestBody);
  if (wants.length === 0) return json({ error: "no_wants" }, 400);

  // IDOR guard: objects are content-addressed and shared across repos, so a
  // `want` MUST be an advertised tip of THIS repo — otherwise a client could
  // pull another repo's objects by SHA.
  const refs = await advertisedRefs(bucket, repo);
  for (const want of wants) {
    if (!refs.tips.has(want)) return json({ error: "invalid_want" }, 400);
  }

  const shas = await collectReachableObjects(bucket, wants, new Set(haves));
  const { pack, missing } = await writePackFromShas(bucket, shas);
  if (missing.length > 0) return json({ error: "repository_incomplete" }, 500);

  const response = concatBytes(pktLineString("NAK\n"), pack);
  return new Response(bytesToBody(response), {
    status: 200,
    headers: {
      "content-type": "application/x-git-upload-pack-result",
      "cache-control": "no-cache",
    },
  });
}
