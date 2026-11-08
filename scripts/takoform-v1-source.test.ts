import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareGitTakoformSource, WORKER_OUTPUT } from "./prepare-takoform-v1-source.ts";

const fixtureWorker = 'export default { fetch() { return new Response("Office"); } };\n';
const sha = (value: Uint8Array | string) => "sha256:" + createHash("sha256").update(value).digest("hex");

test("source preparation stages the exact built Worker and reports its digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-source-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/worker.js"), fixtureWorker);
    const result = await prepareGitTakoformSource(root);
    const staged = await readFile(join(root, WORKER_OUTPUT));
    expect(staged.toString()).toBe(fixtureWorker);
    expect(result.workerSha256).toBe(sha(staged));
    expect(result.workerBytes).toBe(staged.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid or missing source never replaces a previously prepared artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-source-"));
  try {
    const output = join(root, WORKER_OUTPUT);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, fixtureWorker);
    await expect(prepareGitTakoformSource(root)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(fixtureWorker);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/worker.js"), "");
    await expect(prepareGitTakoformSource(root)).rejects.toThrow("size is outside");
    expect(await readFile(output, "utf8")).toBe(fixtureWorker);
  } finally { await rm(root, { recursive: true, force: true }); }
});
