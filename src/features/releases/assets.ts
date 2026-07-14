/**
 * Release asset handlers (upload / list / download / delete).
 *
 * Asset BYTES live in R2 under a repo-scoped `release-assets/<repo>/<release>/…`
 * prefix — separate keys from Git objects/refs, honoring the "objects+refs
 * authoritative; assets are separate keys" invariant (assets are NOT git
 * objects). D1 stores the pointer + metadata (name, content-type, size,
 * checksum). Reads use `contents.read` (draft assets gated to writer+); mutations
 * use `releases.write` + `csrfGuard`.
 */

import { SCOPES, roleAtLeast } from "../../contract/v1.ts";
import type { RouteContext } from "../../router.ts";
import { csrfGuard, requireRepoAccess } from "../repos/identity.ts";
import { errorResponse, json } from "../repos/http.ts";
import { toAssetDto } from "./dto.ts";
import {
  getAssetRow,
  getReleaseByTag,
  listAssetRows,
  storageKeyOf,
} from "./service.ts";

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/u).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/gu, "").replace(/^\.+/u, "").trim();
  const safe = cleaned.replace(/[^A-Za-z0-9._-]/gu, "_");
  return safe.slice(0, 255) || "asset";
}

function detectContentType(fileName: string, provided: string | null): string {
  if (provided && provided !== "application/octet-stream") return provided;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return provided || "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/"/gu, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

interface UploadPart {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly providedType: string | null;
}

async function readUpload(ctx: RouteContext): Promise<UploadPart | Response> {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await ctx.request.formData();
    } catch {
      return errorResponse(400, "invalid_body", "Malformed multipart body.");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return errorResponse(422, "no_file", "A `file` part is required.");
    }
    if (file.size > MAX_ASSET_BYTES) {
      return errorResponse(413, "file_too_large", "Asset exceeds the 100MB limit.");
    }
    const explicitName = form.get("name");
    const fileName = sanitizeFilename(
      (typeof explicitName === "string" && explicitName) || file.name || "asset",
    );
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName,
      providedType: file.type || null,
    };
  }
  // Raw body upload: name comes from ?name=, content-type from the header.
  const name = ctx.url.searchParams.get("name");
  if (!name) {
    return errorResponse(
      422,
      "name_required",
      "Raw uploads require a `?name=` query parameter.",
    );
  }
  const buffer = await ctx.request.arrayBuffer();
  if (buffer.byteLength > MAX_ASSET_BYTES) {
    return errorResponse(413, "file_too_large", "Asset exceeds the 100MB limit.");
  }
  return {
    bytes: new Uint8Array(buffer),
    fileName: sanitizeFilename(name),
    providedType: contentType.split(";")[0]?.trim() || null,
  };
}

export async function uploadAssetHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo } = access;

  const release = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!release) return errorResponse(404, "not_found", "Release not found.");

  const upload = await readUpload(ctx);
  if (upload instanceof Response) return upload;
  if (upload.bytes.byteLength === 0) {
    return errorResponse(422, "empty_file", "Empty asset.");
  }

  const duplicate = await db.queryOne<{ id: string }>(
    `SELECT id FROM release_assets WHERE release_id = ? AND name = ?`,
    [release.id, upload.fileName],
  );
  if (duplicate) {
    return errorResponse(409, "asset_exists", "An asset with this name already exists.");
  }

  const assetId = db.id();
  const now = db.now();
  const storageKey = storageKeyOf(repo);
  const r2Key = `release-assets/${storageKey}/${release.id}/${assetId}/${upload.fileName}`;
  const contentType = detectContentType(upload.fileName, upload.providedType);
  const checksum = await sha256Hex(upload.bytes);

  // R2 first (bytes are authoritative for the asset), then the D1 pointer.
  await ctx.env.BUCKET.put(r2Key, upload.bytes);
  await db.run(
    `INSERT INTO release_assets
       (id, release_id, name, r2_key, content_type, size_bytes, checksum_sha256, download_count, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'uploaded', ?)`,
    [
      assetId,
      release.id,
      upload.fileName,
      r2Key,
      contentType,
      upload.bytes.byteLength,
      checksum,
      now,
    ],
  );

  const row = await getAssetRow(db, release.id, assetId);
  return json({ asset: row ? toAssetDto(row) : null }, 201);
}

export async function listAssetsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo, role } = access;
  const release = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!release) return errorResponse(404, "not_found", "Release not found.");
  if (release.is_draft !== 0 && !roleAtLeast(role, "writer")) {
    return errorResponse(404, "not_found", "Release not found.");
  }
  const rows = await listAssetRows(db, release.id);
  return json({ assets: rows.map(toAssetDto) });
}

export async function downloadAssetHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo, role } = access;
  const release = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!release) return errorResponse(404, "not_found", "Release not found.");
  if (release.is_draft !== 0 && !roleAtLeast(role, "writer")) {
    return errorResponse(404, "not_found", "Release not found.");
  }
  const asset = await getAssetRow(db, release.id, ctx.params.id);
  if (!asset) return errorResponse(404, "not_found", "Asset not found.");

  const object = await ctx.env.BUCKET.get(asset.r2_key);
  if (!object) return errorResponse(404, "not_found", "Asset bytes not found.");
  const bytes = new Uint8Array(await object.arrayBuffer());

  await db.run(
    `UPDATE release_assets SET download_count = download_count + 1 WHERE id = ?`,
    [asset.id],
  );

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": asset.content_type ?? "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDisposition(asset.name),
      "cache-control": "private, no-store",
    },
  });
}

export async function deleteAssetHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo } = access;
  const asset = await db.queryOne<{ id: string; r2_key: string }>(
    `SELECT ra.id AS id, ra.r2_key AS r2_key
       FROM release_assets ra JOIN releases r ON r.id = ra.release_id
      WHERE r.repo_id = ? AND ra.id = ?`,
    [repo.id, ctx.params.id],
  );
  if (!asset) return errorResponse(404, "not_found", "Asset not found.");
  await ctx.env.BUCKET.delete(asset.r2_key);
  await db.run(`DELETE FROM release_assets WHERE id = ?`, [asset.id]);
  return json({ deleted: true });
}

export const assetHandlers = {
  upload: uploadAssetHandler,
  list: listAssetsHandler,
  download: downloadAssetHandler,
  remove: deleteAssetHandler,
};
