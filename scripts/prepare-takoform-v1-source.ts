#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_OUTPUT = "deploy/takoform-v1/.generated/git-worker.js";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/** Stages only this source's built Worker, without publishing or provider calls. */
export async function prepareGitTakoformSource(repositoryRoot = ROOT) {
  const bytes = await readFile(join(repositoryRoot, "dist/worker.js"));
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
    throw new Error("Git Worker artifact size is outside the accepted range");
  }
  const workerSha256 = digest(bytes);
  const output = join(repositoryRoot, WORKER_OUTPUT);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    if (digest(await readFile(temporary)) !== workerSha256) throw new Error("Prepared Worker digest mismatch");
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { workerBytes: bytes.length, workerSha256 };
}

if (import.meta.main) {
  console.log(JSON.stringify({ kind: "takos-git.takoform-v1-source@v1", ...await prepareGitTakoformSource() }));
}
