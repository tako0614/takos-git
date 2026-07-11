/**
 * Git Smart HTTP v0/v1 upload-pack + receive-pack implementation.
 *
 * Authentication and repo-prefix authorization stay in `worker.ts`. This file
 * owns protocol parsing, pack validation/storage, and all-or-nothing ref
 * updates for one receive-pack request.
 */

import type { ObjectStoreBinding } from "./git/types.ts";
import { getCommitData, getObject, getTreeEntries, objectExists, putObject } from "./git/object-store.ts";
import { readPack } from "./git/pack-reader.ts";
import { writePackFromShas } from "./git/pack.ts";
import { parsePktLines, PKT_FLUSH, pktLineString } from "./git/pack-common.ts";
import { concatBytes } from "./git/sha1.ts";
import {
  isValidRefName,
  readRepoRefs,
  readRepoRefsSnapshot,
  writeRepoRefs,
  type RefsDoc,
} from "./git/refs-store.ts";
import { collectReachableObjects } from "./git/reachability.ts";

const ZERO_OID = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;
const AGENT = "agent=takos-git/0.2";
const RECEIVE_CAPABILITIES = [
  "report-status",
  "delete-refs",
  "ofs-delta",
  "atomic",
  "object-format=sha1",
  AGENT,
].join(" ");
const MAX_REF_COMMANDS = 128;
const MAX_REACHABLE_OBJECTS = 100_000;

export type GitService = "git-upload-pack" | "git-receive-pack";

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

function buildUploadAdvertisement(refs: AdvertisedRefs): Uint8Array {
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

function buildReceiveAdvertisement(refs: AdvertisedRefs): Uint8Array {
  const parts: Uint8Array[] = [
    pktLineString("# service=git-receive-pack\n"),
    PKT_FLUSH,
  ];
  const refsWithoutHead = refs.lines.filter((ref) => ref.name !== "HEAD");
  if (refsWithoutHead.length === 0) {
    parts.push(
      pktLineString(
        `${ZERO_OID} capabilities^{}\0${RECEIVE_CAPABILITIES}\n`,
      ),
    );
  } else {
    refsWithoutHead.forEach((line, index) => {
      const suffix = index === 0 ? `\0${RECEIVE_CAPABILITIES}` : "";
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
      if (OID.test(sha)) wants.push(sha);
    } else if (text.startsWith("have ")) {
      const sha = text.slice(5, 45);
      if (OID.test(sha)) haves.push(sha);
    }
  }
  return { wants, haves };
}

export async function handleInfoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
  service: GitService,
): Promise<Response> {
  const refs = await advertisedRefs(bucket, repo);
  const body = service === "git-upload-pack"
    ? buildUploadAdvertisement(refs)
    : buildReceiveAdvertisement(refs);
  return new Response(bytesToBody(body), {
    status: 200,
    headers: {
      "content-type": `application/x-${service}-advertisement`,
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

  // Objects are shared by content id, so every want must be a tip advertised
  // by this repository. Otherwise a caller could request another repo's object.
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

interface RefCommand {
  readonly oldSha: string;
  readonly newSha: string;
  readonly name: string;
}

interface ReceiveRequest {
  readonly commands: readonly RefCommand[];
  readonly capabilities: ReadonlySet<string>;
  readonly pack: Uint8Array;
}

function parseReceiveRequest(body: Uint8Array): ReceiveRequest {
  const decoder = new TextDecoder();
  const commands: RefCommand[] = [];
  let capabilities: ReadonlySet<string> = new Set();
  let offset = 0;

  for (;;) {
    if (offset + 4 > body.length) throw new Error("truncated command pkt-line");
    const lengthText = decoder.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
      throw new Error("invalid command pkt-line length");
    }
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      throw new Error("truncated command pkt-line");
    }
    if (commands.length >= MAX_REF_COMMANDS) throw new Error("too many ref commands");
    let line = decoder.decode(body.subarray(offset + 4, offset + length));
    offset += length;
    if (line.endsWith("\n")) line = line.slice(0, -1);

    const nul = line.indexOf("\0");
    if (commands.length === 0 && nul !== -1) {
      capabilities = new Set(line.slice(nul + 1).split(" ").filter(Boolean));
      line = line.slice(0, nul);
    } else if (nul !== -1) {
      throw new Error("capabilities are only valid on the first command");
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!match) throw new Error("malformed ref command");
    const [, oldSha, newSha, name] = match;
    if (!isValidRefName(name)) throw new Error("invalid ref name");
    if (oldSha === ZERO_OID && newSha === ZERO_OID) {
      throw new Error("empty ref update");
    }
    if (commands.some((command) => command.name === name)) {
      throw new Error("duplicate ref command");
    }
    commands.push({ oldSha, newSha, name });
  }

  if (commands.length === 0) throw new Error("no ref commands");
  return { commands, capabilities, pack: body.subarray(offset) };
}

function receiveResponse(
  commands: readonly RefCommand[],
  failure?: string,
): Response {
  const safeFailure = failure?.replace(/[\0\r\n]/g, " ").slice(0, 160);
  const parts: Uint8Array[] = [pktLineString("unpack ok\n")];
  for (const command of commands) {
    parts.push(
      pktLineString(
        safeFailure ? `ng ${command.name} ${safeFailure}\n` : `ok ${command.name}\n`,
      ),
    );
  }
  parts.push(PKT_FLUSH);
  return new Response(bytesToBody(concatBytes(...parts)), {
    status: 200,
    headers: {
      "content-type": "application/x-git-receive-pack-result",
      "cache-control": "no-cache",
    },
  });
}

function unpackFailure(message: string): Response {
  const safeMessage = message.replace(/[\0\r\n]/g, " ").slice(0, 160);
  return new Response(
    bytesToBody(concatBytes(pktLineString(`unpack ${safeMessage}\n`), PKT_FLUSH)),
    {
      status: 200,
      headers: {
        "content-type": "application/x-git-receive-pack-result",
        "cache-control": "no-cache",
      },
    },
  );
}

async function isAncestor(
  bucket: ObjectStoreBinding,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const queue = [descendant];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === ancestor) return true;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (visited.size > MAX_REACHABLE_OBJECTS) throw new Error("commit graph too large");
    const commit = await getCommitData(bucket, sha);
    if (!commit) return false;
    queue.push(...commit.parents);
  }
  return false;
}

async function validateTreeClosure(
  bucket: ObjectStoreBinding,
  root: string,
  visited: Set<string>,
): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (visited.size > MAX_REACHABLE_OBJECTS) throw new Error("object graph too large");
    const entries = await getTreeEntries(bucket, sha);
    if (!entries) throw new Error("missing or invalid tree object");
    for (const entry of entries) {
      if (entry.mode === "160000") continue;
      if (entry.mode === "040000" || entry.mode === "40000") {
        queue.push(entry.sha);
      } else if (!(await objectExists(bucket, entry.sha))) {
        throw new Error("missing tree entry object");
      }
    }
  }
}

async function validateCommitClosure(
  bucket: ObjectStoreBinding,
  root: string,
): Promise<void> {
  const commits = [root];
  const visitedCommits = new Set<string>();
  const visitedTrees = new Set<string>();
  while (commits.length > 0) {
    const sha = commits.pop() as string;
    if (visitedCommits.has(sha)) continue;
    visitedCommits.add(sha);
    if (visitedCommits.size > MAX_REACHABLE_OBJECTS) {
      throw new Error("commit graph too large");
    }
    const commit = await getCommitData(bucket, sha);
    if (!commit) throw new Error("branch target is not a valid commit");
    await validateTreeClosure(bucket, commit.tree, visitedTrees);
    commits.push(...commit.parents);
  }
}

function nextRefsDoc(current: RefsDoc, commands: readonly RefCommand[]): RefsDoc {
  const refs = new Map(current.refs.map((ref) => [ref.name, ref.sha]));
  for (const command of commands) {
    if (command.newSha === ZERO_OID) refs.delete(command.name);
    else refs.set(command.name, command.newSha);
  }
  const records = [...refs.entries()]
    .map(([name, sha]) => ({ name, sha }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const branches = records
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length));
  const defaultBranch = current.defaultBranch && branches.includes(current.defaultBranch)
    ? current.defaultBranch
    : branches.includes("main")
      ? "main"
      : (branches[0] ?? null);
  return { refs: records, defaultBranch };
}

export async function handleReceivePack(
  bucket: ObjectStoreBinding,
  repo: string,
  requestBody: Uint8Array,
): Promise<Response> {
  let receive: ReceiveRequest;
  try {
    receive = parseReceiveRequest(requestBody);
  } catch (error) {
    return unpackFailure(error instanceof Error ? error.message : "invalid request");
  }

  if (!receive.capabilities.has("report-status")) {
    return receiveResponse(receive.commands, "report-status capability required");
  }
  const snapshot = await readRepoRefsSnapshot(bucket, repo);
  if (!snapshot) return receiveResponse(receive.commands, "repository not found");
  const current = snapshot.doc;
  const currentRefs = new Map(current.refs.map((ref) => [ref.name, ref.sha]));
  for (const command of receive.commands) {
    if ((currentRefs.get(command.name) ?? ZERO_OID) !== command.oldSha) {
      return receiveResponse(receive.commands, "stale ref value");
    }
    if (command.newSha === ZERO_OID && !receive.capabilities.has("delete-refs")) {
      return receiveResponse(receive.commands, "delete-refs capability required");
    }
  }

  try {
    if (receive.pack.length > 0) {
      if (
        receive.pack.length < 4 ||
        new TextDecoder().decode(receive.pack.subarray(0, 4)) !== "PACK"
      ) {
        throw new Error("missing PACK payload");
      }
      const objects = await readPack(receive.pack, {
        resolveExternalBase: async (sha) => (await getObject(bucket, sha))?.content ?? null,
      });
      for (const object of objects) {
        const storedSha = await putObject(bucket, object.type, object.content);
        if (storedSha !== object.sha) throw new Error("object id mismatch");
      }
    }

    for (const command of receive.commands) {
      if (command.newSha === ZERO_OID) continue;
      if (!(await objectExists(bucket, command.newSha))) {
        throw new Error("new ref target is missing");
      }
      if (command.name.startsWith("refs/heads/")) {
        await validateCommitClosure(bucket, command.newSha);
        if (
          command.oldSha !== ZERO_OID &&
          !(await isAncestor(bucket, command.oldSha, command.newSha))
        ) {
          throw new Error("non-fast-forward branch update");
        }
      }
    }
  } catch (error) {
    return receiveResponse(
      receive.commands,
      error instanceof Error ? error.message : "pack rejected",
    );
  }

  const written = await writeRepoRefs(
    bucket,
    repo,
    nextRefsDoc(current, receive.commands),
    snapshot.etag,
  );
  if (!written) {
    return receiveResponse(receive.commands, "concurrent ref update");
  }
  return receiveResponse(receive.commands);
}
