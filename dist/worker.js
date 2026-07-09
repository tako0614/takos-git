// src/git-token.ts
var TOKEN_PREFIX = "takstor_";
var AUDIENCE = "source.git.smart_http";
function b64urlDecode(value) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0)
    normalized += "=";
  const binary = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0;i < binary.length; i++)
    out[i] = binary.charCodeAt(i);
  return out;
}
async function importHmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function verifyGitToken(signingKey, token, nowSeconds) {
  if (!token.startsWith(TOKEN_PREFIX))
    return { ok: false, reason: "format" };
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1)
    return { ok: false, reason: "format" };
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  const key = await importHmacKey(signingKey);
  let signatureOk = false;
  try {
    signatureOk = await crypto.subtle.verify("HMAC", key, b64urlDecode(signature), new TextEncoder().encode(body));
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!signatureOk)
    return { ok: false, reason: "signature" };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (payload.v !== 1 || payload.aud !== AUDIENCE || !Array.isArray(payload.cap)) {
    return { ok: false, reason: "version" };
  }
  if (typeof payload.pfx !== "string" || payload.pfx.length === 0) {
    return { ok: false, reason: "version" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
function gitTokenAllows(payload, verb, repo) {
  if (!payload.cap.includes(verb))
    return false;
  if (!payload.pfx)
    return false;
  return repo === payload.pfx || repo.startsWith(`${payload.pfx}/`);
}

// src/git/sha1.ts
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0;i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
function toBufferSource(bytes) {
  return bytes.slice().buffer;
}
async function sha1(data) {
  const hashBuffer = await crypto.subtle.digest("SHA-1", toBufferSource(data));
  return hexFromBuffer(hashBuffer);
}
function hexFromBuffer(buffer) {
  return bytesToHex(new Uint8Array(buffer));
}
function concatBytes(...arrays) {
  let totalLength = 0;
  for (const arr of arrays)
    totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// src/git/git-objects.ts
var SHA1_PATTERN = /^[0-9a-f]{40}$/;
function isValidSha(sha) {
  return SHA1_PATTERN.test(sha);
}

// src/git/object.ts
var TEXT_ENCODER = new TextEncoder;
var TEXT_DECODER = new TextDecoder;
function decodeObjectHeader(raw) {
  const nullIdx = raw.indexOf(0);
  if (nullIdx === -1) {
    throw new Error("Invalid git object: no null byte in header");
  }
  const headerStr = TEXT_DECODER.decode(raw.subarray(0, nullIdx));
  const spaceIdx = headerStr.indexOf(" ");
  if (spaceIdx === -1)
    throw new Error("Invalid git object header");
  const type = headerStr.substring(0, spaceIdx);
  const size = parseInt(headerStr.substring(spaceIdx + 1), 10);
  return { type, size, contentOffset: nullIdx + 1 };
}
function decodeObject(raw) {
  const { type, contentOffset } = decodeObjectHeader(raw);
  return { type, content: raw.subarray(contentOffset) };
}
function decodeTree(content) {
  const entries = [];
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(32, offset);
    if (spaceIdx === -1)
      break;
    const mode = TEXT_DECODER.decode(content.subarray(offset, spaceIdx));
    const normalizedMode = mode.padStart(6, "0");
    const nullIdx = content.indexOf(0, spaceIdx + 1);
    if (nullIdx === -1)
      break;
    const name = TEXT_DECODER.decode(content.subarray(spaceIdx + 1, nullIdx));
    const shaBytes = content.subarray(nullIdx + 1, nullIdx + 21);
    if (shaBytes.length < 20)
      break;
    const sha = hexFromBuffer(shaBytes.slice().buffer);
    entries.push({ mode: normalizedMode, name, sha });
    offset = nullIdx + 21;
  }
  return entries;
}
function decodeCommit(content) {
  const text = TEXT_DECODER.decode(content);
  const blankLineIdx = text.indexOf(`

`);
  const headerSection = blankLineIdx !== -1 ? text.substring(0, blankLineIdx) : text;
  const message = blankLineIdx !== -1 ? text.substring(blankLineIdx + 2) : "";
  let tree = "";
  const parents = [];
  let author = null;
  let committer = null;
  for (const line of headerSection.split(`
`)) {
    if (line.startsWith("tree ")) {
      tree = line.substring(5);
    } else if (line.startsWith("parent ")) {
      parents.push(line.substring(7));
    } else if (line.startsWith("author ")) {
      author = parseSignature(line.substring(7));
    } else if (line.startsWith("committer ")) {
      committer = parseSignature(line.substring(10));
    }
  }
  if (!tree || !author || !committer) {
    throw new Error("Invalid commit object: missing required fields");
  }
  return { sha: "", tree, parents, author, committer, message };
}
function parseSignature(raw) {
  const emailEnd = raw.lastIndexOf(">");
  if (emailEnd === -1)
    throw new Error("Invalid signature: no email");
  const emailStart = raw.lastIndexOf("<", emailEnd);
  if (emailStart === -1)
    throw new Error("Invalid signature: no email start");
  const name = raw.substring(0, emailStart).trim();
  const email = raw.substring(emailStart + 1, emailEnd);
  const rest = raw.substring(emailEnd + 1).trim().split(" ");
  const timestamp = parseInt(rest[0], 10);
  const tzOffset = rest[1] || "+0000";
  return { name, email, timestamp, tzOffset };
}

// src/git/object-store.ts
var OBJECT_PREFIX = "git/v2/objects";
function getObjectKey(sha) {
  return `${OBJECT_PREFIX}/${sha.substring(0, 2)}/${sha.substring(2)}`;
}
function toArrayBufferView(data) {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes;
}
async function deflate(data) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(toArrayBufferView(data));
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}
async function inflate(data) {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(toArrayBufferView(data));
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}
async function getRawObject(bucket, sha) {
  if (!isValidSha(sha))
    return null;
  const key = getObjectKey(sha);
  const obj = await bucket.get(key);
  if (!obj)
    return null;
  const compressed = new Uint8Array(await obj.arrayBuffer());
  return inflate(compressed);
}
async function getObject(bucket, sha) {
  const raw = await getRawObject(bucket, sha);
  if (!raw)
    return null;
  return decodeObject(raw);
}
async function getTreeEntries(bucket, sha) {
  const obj = await getObject(bucket, sha);
  if (!obj || obj.type !== "tree")
    return null;
  return decodeTree(obj.content);
}
async function getCommitData(bucket, sha) {
  const obj = await getObject(bucket, sha);
  if (!obj || obj.type !== "commit")
    return null;
  const commit = decodeCommit(obj.content);
  commit.sha = sha;
  return commit;
}

// src/git/pack-common.ts
var TEXT_ENCODER2 = new TextEncoder;
var TEXT_DECODER2 = new TextDecoder;
var PACK_OBJ = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
  OFS_DELTA: 6,
  REF_DELTA: 7
};
var TYPE_TO_NUMBER = {
  commit: PACK_OBJ.COMMIT,
  tree: PACK_OBJ.TREE,
  blob: PACK_OBJ.BLOB,
  tag: PACK_OBJ.TAG
};
var NUMBER_TO_TYPE = {
  [PACK_OBJ.COMMIT]: "commit",
  [PACK_OBJ.TREE]: "tree",
  [PACK_OBJ.BLOB]: "blob",
  [PACK_OBJ.TAG]: "tag"
};
function gitTypeToNumber(type) {
  const n = TYPE_TO_NUMBER[type];
  if (n === undefined)
    throw new Error(`unknown git object type: ${type}`);
  return n;
}
function encodePackObjectHeader(type, size) {
  const bytes = [];
  let b = type << 4 | size & 15;
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 128);
    b = size & 127;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return new Uint8Array(bytes);
}
var PKT_FLUSH = TEXT_ENCODER2.encode("0000");
function toHex4(n) {
  return n.toString(16).padStart(4, "0");
}
function pktLine(payload) {
  const len = payload.length + 4;
  if (len > 65535)
    throw new Error("pkt-line payload too large");
  return concatBytes(TEXT_ENCODER2.encode(toHex4(len)), payload);
}
function pktLineString(text) {
  return pktLine(TEXT_ENCODER2.encode(text));
}
function parsePktLines(data) {
  const lines = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const hex = TEXT_DECODER2.decode(data.subarray(offset, offset + 4));
    const len = parseInt(hex, 16);
    if (Number.isNaN(len))
      throw new Error(`invalid pkt-line length: ${hex}`);
    if (len === 0 || len === 1 || len === 2) {
      lines.push({ payload: null });
      offset += 4;
      continue;
    }
    if (len < 4)
      throw new Error(`invalid pkt-line length: ${len}`);
    const end = offset + len;
    if (end > data.length)
      throw new Error("truncated pkt-line");
    lines.push({ payload: data.subarray(offset + 4, end) });
    offset = end;
  }
  return lines;
}

// src/git/pack.ts
var TEXT_ENCODER3 = new TextEncoder;
function packHeader(objectCount) {
  const header = new Uint8Array(12);
  header.set(TEXT_ENCODER3.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, objectCount, false);
  return header;
}
async function writePack(objects) {
  const chunks = [packHeader(objects.length)];
  for (const obj of objects) {
    chunks.push(encodePackObjectHeader(gitTypeToNumber(obj.type), obj.content.length));
    chunks.push(await deflate(obj.content));
  }
  const body = concatBytes(...chunks);
  const trailer = hexToBytes(await sha1(body));
  return concatBytes(body, trailer);
}
async function writePackFromShas(bucket, shas) {
  const objects = [];
  const missing = [];
  for (const sha of shas) {
    const obj = await getObject(bucket, sha);
    if (!obj) {
      missing.push(sha);
      continue;
    }
    objects.push({ type: obj.type, content: obj.content });
  }
  const pack = await writePack(objects);
  return { pack, written: objects.length, missing };
}

// src/git/refs-store.ts
var EMPTY = { refs: [], defaultBranch: null };
function refsKey(repo) {
  return `git/v2/refs/${repo}.json`;
}
function isValidRepoName(repo) {
  return /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/.test(repo) && !repo.includes("..");
}
async function readRepoRefs(bucket, repo) {
  if (!isValidRepoName(repo))
    return EMPTY;
  const object = await bucket.get(refsKey(repo));
  if (!object)
    return EMPTY;
  try {
    const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
    const parsed = JSON.parse(text);
    const refs = Array.isArray(parsed.refs) ? parsed.refs.filter((ref) => !!ref && typeof ref.name === "string" && /^[0-9a-f]{40}$/.test(ref.sha ?? "")) : [];
    return {
      refs,
      defaultBranch: typeof parsed.defaultBranch === "string" ? parsed.defaultBranch : null
    };
  } catch {
    return EMPTY;
  }
}

// src/git/reachability.ts
var TREE_MODES = new Set(["040000", "40000"]);
var GITLINK_MODE = "160000";
async function collectTreeObjects(bucket, treeSha, out) {
  if (out.has(treeSha))
    return;
  out.add(treeSha);
  const entries = await getTreeEntries(bucket, treeSha);
  if (!entries)
    return;
  for (const entry of entries) {
    if (out.has(entry.sha))
      continue;
    if (TREE_MODES.has(entry.mode)) {
      await collectTreeObjects(bucket, entry.sha, out);
    } else if (entry.mode !== GITLINK_MODE) {
      out.add(entry.sha);
    }
  }
}
async function collectReachableObjects(bucket, wants, haves) {
  const objects = new Set;
  const visitedCommits = new Set;
  const queue = [...wants];
  while (queue.length > 0) {
    const sha = queue.pop();
    if (visitedCommits.has(sha) || haves.has(sha))
      continue;
    visitedCommits.add(sha);
    const commit = await getCommitData(bucket, sha);
    if (!commit)
      continue;
    objects.add(sha);
    await collectTreeObjects(bucket, commit.tree, objects);
    for (const parent of commit.parents) {
      if (!visitedCommits.has(parent) && !haves.has(parent))
        queue.push(parent);
    }
  }
  return [...objects];
}

// src/smart-http.ts
var ZERO_OID = "0".repeat(40);
var AGENT = "agent=takos-git/0.1";
function bytesToBody(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
async function advertisedRefs(bucket, repo) {
  const doc = await readRepoRefs(bucket, repo);
  const lines = [];
  const tips = new Set;
  let headSymref = null;
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
function buildAdvertisement(refs) {
  const capParts = [AGENT, "object-format=sha1"];
  if (refs.headSymref)
    capParts.unshift(`symref=HEAD:${refs.headSymref}`);
  const caps = capParts.join(" ");
  const parts = [
    pktLineString(`# service=git-upload-pack
`),
    PKT_FLUSH
  ];
  if (refs.lines.length === 0) {
    parts.push(pktLineString(`${ZERO_OID} capabilities^{}\x00${caps}
`));
  } else {
    refs.lines.forEach((line, index) => {
      const suffix = index === 0 ? `\x00${caps}` : "";
      parts.push(pktLineString(`${line.sha} ${line.name}${suffix}
`));
    });
  }
  parts.push(PKT_FLUSH);
  return concatBytes(...parts);
}
function parseUploadPackRequest(body) {
  const wants = [];
  const haves = [];
  const decoder = new TextDecoder;
  for (const line of parsePktLines(body)) {
    if (!line.payload)
      continue;
    const text = decoder.decode(line.payload).trimEnd();
    if (text.startsWith("want ")) {
      const sha = text.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(sha))
        wants.push(sha);
    } else if (text.startsWith("have ")) {
      const sha = text.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(sha))
        haves.push(sha);
    }
  }
  return { wants, haves };
}
async function handleInfoRefs(bucket, repo) {
  const refs = await advertisedRefs(bucket, repo);
  return new Response(bytesToBody(buildAdvertisement(refs)), {
    status: 200,
    headers: {
      "content-type": "application/x-git-upload-pack-advertisement",
      "cache-control": "no-cache"
    }
  });
}
async function handleUploadPack(bucket, repo, requestBody) {
  const { wants, haves } = parseUploadPackRequest(requestBody);
  if (wants.length === 0)
    return json({ error: "no_wants" }, 400);
  const refs = await advertisedRefs(bucket, repo);
  for (const want of wants) {
    if (!refs.tips.has(want))
      return json({ error: "invalid_want" }, 400);
  }
  const shas = await collectReachableObjects(bucket, wants, new Set(haves));
  const { pack, missing } = await writePackFromShas(bucket, shas);
  if (missing.length > 0)
    return json({ error: "repository_incomplete" }, 500);
  const response = concatBytes(pktLineString(`NAK
`), pack);
  return new Response(bytesToBody(response), {
    status: 200,
    headers: {
      "content-type": "application/x-git-upload-pack-result",
      "cache-control": "no-cache"
    }
  });
}

// src/worker.ts
var GIT_PREFIX = "/git/";
function json2(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
function gitConsoleHtml(origin) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Takos Git</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { width: min(920px, calc(100% - 32px)); margin: 32px auto; display: grid; gap: 18px; }
    header { display: grid; gap: 6px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    p { margin: 0; color: color-mix(in srgb, CanvasText 70%, transparent); }
    section { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; display: grid; gap: 14px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 10px 11px; background: Canvas; color: CanvasText; font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 9px 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText; font: inherit; cursor: pointer; }
    button.primary { background: CanvasText; color: Canvas; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; overflow: auto; border-radius: 6px; padding: 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); min-height: 88px; font-size: 13px; line-height: 1.45; }
    .muted { font-size: 13px; color: color-mix(in srgb, CanvasText 62%, transparent); }
    @media (max-width: 720px) { main { width: min(100% - 20px, 920px); margin: 18px auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Takos Git</h1>
      <p>Read-only Git Smart HTTP endpoint for this Capsule.</p>
    </header>
    <section>
      <label>Repository
        <input id="repo" value="example/repo" placeholder="owner/repository">
      </label>
      <label>Access token
        <input id="token" type="password" autocomplete="off" placeholder="Scoped clone token minted by Takosumi">
      </label>
      <div class="actions">
        <button id="health">Check service</button>
        <button id="refs" class="primary">Check refs</button>
        <button id="clone">Show clone command</button>
      </div>
      <p class="muted">Push is disabled in this service version. Use Takosumi-managed import or release flows to write repositories.</p>
    </section>
    <section>
      <pre id="result">Base URL: ${origin}/git</pre>
    </section>
  </main>
  <script>
    const byId = (id) => document.getElementById(id);
    const result = byId("result");
    function repoPath() {
      return byId("repo").value.trim().replace(/^\\/+|\\/+$/g, "");
    }
    function repoUrlPart(repo) {
      return repo.split("/").map(encodeURIComponent).join("/");
    }
    function tokenHeaders() {
      const token = byId("token").value.trim();
      return token ? { authorization: "Bearer " + token } : {};
    }
    function print(value) {
      result.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
    byId("health").addEventListener("click", async () => {
      const response = await fetch("/healthz");
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      print({ status: response.status, ok: response.ok, body });
    });
    byId("refs").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      const response = await fetch("/git/" + repoUrlPart(repo) + ".git/info/refs?service=git-upload-pack", {
        headers: tokenHeaders(),
      });
      print({ status: response.status, ok: response.ok, contentType: response.headers.get("content-type"), body: await response.text() });
    });
    byId("clone").addEventListener("click", () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      const token = byId("token").value.trim();
      const auth = token ? "x:" + encodeURIComponent(token) + "@" : "";
      print("git -c protocol.version=1 clone " + window.location.protocol + "//" + auth + window.location.host + "/git/" + repoUrlPart(repo) + ".git");
    });
  </script>
</body>
</html>`;
}
function unauthorized() {
  return new Response(JSON.stringify({ error: "git_unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Basic realm="Takos Git", charset="UTF-8"'
    }
  });
}
function tokenFromRequest(request) {
  const header = request.headers.get("authorization");
  if (!header)
    return null;
  const [scheme, encoded] = header.split(" ", 2);
  if (!scheme || !encoded)
    return null;
  if (scheme.toLowerCase() === "bearer")
    return encoded;
  if (scheme.toLowerCase() !== "basic")
    return null;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
    const colon = decoded.indexOf(":");
    return colon === -1 ? decoded : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}
function parseGitPath(pathname) {
  if (!pathname.startsWith(GIT_PREFIX))
    return null;
  for (const suffix of ["/info/refs", "/git-upload-pack", "/git-receive-pack"]) {
    if (pathname.endsWith(suffix)) {
      const repoRaw = pathname.slice(GIT_PREFIX.length, -suffix.length);
      const repo = repoRaw.replace(/\.git$/, "");
      return { repo, suffix };
    }
  }
  return null;
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json2({ status: "ok", service: "takos-git" }, 200);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return html(gitConsoleHtml(url.origin));
    }
    const route = parseGitPath(url.pathname);
    if (!route)
      return json2({ error: "not_found" }, 404);
    if (!route.repo || !isValidRepoName(route.repo)) {
      return json2({ error: "invalid_repository" }, 404);
    }
    if (route.suffix === "/git-receive-pack") {
      return json2({ error: "git_push_disabled" }, 403);
    }
    if (route.suffix === "/info/refs" && url.searchParams.get("service") === "git-receive-pack") {
      return json2({ error: "git_push_disabled" }, 403);
    }
    if (route.suffix === "/info/refs") {
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack") {
        return json2({ error: "service_required" }, 400);
      }
    }
    const token = tokenFromRequest(request);
    if (!token)
      return unauthorized();
    if (!env.GIT_TOKEN_SIGNING_KEY) {
      return json2({ error: "git_signing_key_unconfigured" }, 503);
    }
    const verified = await verifyGitToken(env.GIT_TOKEN_SIGNING_KEY, token, nowSeconds);
    if (!verified.ok)
      return unauthorized();
    if (!gitTokenAllows(verified.payload, "r", route.repo)) {
      return json2({ error: "forbidden_repository" }, 403);
    }
    if (route.suffix === "/info/refs") {
      return handleInfoRefs(env.BUCKET, route.repo);
    }
    const body = new Uint8Array(await request.arrayBuffer());
    return handleUploadPack(env.BUCKET, route.repo, body);
  }
};
export {
  worker_default as default
};
