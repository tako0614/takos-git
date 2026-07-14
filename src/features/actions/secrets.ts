/**
 * Actions secrets — repo-scoped, encrypted at rest, write-only over the API.
 *
 * Values are AES-GCM sealed with `ACTIONS_SECRETS_KEY` (falling back to
 * `APP_SESSION_SECRET`) reusing the webhooks crypto primitive, so the plaintext
 * never sits in D1. Reads list names + timestamps ONLY; the ciphertext column
 * (`workflow_secrets.value_enc`) is never returned by any API. The Phase-5b runner
 * decrypts referenced secrets just-in-time via {@link decryptWorkflowSecret}.
 */

import type { DbClient } from "../../db/index.ts";
import { decryptSecret, encryptSecret } from "../webhooks/crypto.ts";
import type { WorkflowSecretDto } from "./dto.ts";

/** Secret names must be uppercase env-identifier shaped (GitHub Actions parity). */
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;

interface RawSecret {
  id: string;
  name: string;
  value_enc: string;
  created_at: number;
  updated_at: number | null;
}

/** List secret names + timestamps (never the value). */
export async function listWorkflowSecrets(
  db: DbClient,
  repoId: string,
): Promise<WorkflowSecretDto[]> {
  const rows = await db.query<{ name: string; created_at: number; updated_at: number | null }>(
    `SELECT name, created_at, updated_at FROM workflow_secrets
      WHERE repo_id = ? ORDER BY name COLLATE NOCASE ASC`,
    [repoId],
  );
  return rows.map((row) => ({
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Create or replace a secret's encrypted value. Returns its timestamps. */
export async function putWorkflowSecret(
  db: DbClient,
  repoId: string,
  name: string,
  value: string,
  keyMaterial: string,
): Promise<WorkflowSecretDto> {
  const valueEnc = await encryptSecret(value, keyMaterial);
  const now = db.now();
  const existing = await db.queryOne<{ id: string; created_at: number }>(
    `SELECT id, created_at FROM workflow_secrets WHERE repo_id = ? AND name = ? LIMIT 1`,
    [repoId, name],
  );
  if (existing) {
    await db.run(
      `UPDATE workflow_secrets SET value_enc = ?, updated_at = ? WHERE id = ?`,
      [valueEnc, now, existing.id],
    );
    return { name, createdAt: existing.created_at, updatedAt: now };
  }
  await db.run(
    `INSERT INTO workflow_secrets (id, repo_id, name, value_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [db.id(), repoId, name, valueEnc, now, now],
  );
  return { name, createdAt: now, updatedAt: now };
}

/** Delete a secret. Returns false when it did not exist. */
export async function deleteWorkflowSecret(
  db: DbClient,
  repoId: string,
  name: string,
): Promise<boolean> {
  const result = await db.run(
    `DELETE FROM workflow_secrets WHERE repo_id = ? AND name = ?`,
    [repoId, name],
  );
  return Boolean(result.meta.changes);
}

/**
 * Decrypt one repo secret by name for injection into a runner. Phase-5b only —
 * never reachable from a customer API. Returns null when absent or on tamper.
 */
export async function decryptWorkflowSecret(
  db: DbClient,
  repoId: string,
  name: string,
  keyMaterial: string,
): Promise<string | null> {
  const row = await db.queryOne<RawSecret>(
    `SELECT id, name, value_enc, created_at, updated_at FROM workflow_secrets
      WHERE repo_id = ? AND name = ? LIMIT 1`,
    [repoId, name],
  );
  if (!row) return null;
  return decryptSecret(row.value_enc, keyMaterial);
}
