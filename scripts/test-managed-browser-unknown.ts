import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const testPath = "tests/managed-browser-session-unknown.tftest.hcl";
const modulePath = "tests/fixtures/managed-browser-session-unknown/main.tf";

/** Keep the parent-reaching test module outside the installable Git tree. */
export function stageUnknownInputFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "takos-git-unknown-"));
  try {
    for (const path of [
      "main.tf",
      "outputs.tf",
      "release.lock.json",
      ".terraform.lock.hcl",
      testPath,
      modulePath,
    ]) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      const source = path === testPath || path === modulePath
        ? `${path}.fixture`
        : path;
      copyFileSync(join(repository, source), target);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true });
    throw error;
  }
}

export function testUnknownInputs(): void {
  const providers = resolve(repository, ".terraform/providers");
  if (!existsSync(providers)) {
    throw new Error("Run the normal root OpenTofu init before the unknown-input tests.");
  }
  const directory = stageUnknownInputFixture();
  let succeeded = false;
  try {
    for (const args of [
      ["init", "-backend=false", "-lockfile=readonly", `-plugin-dir=${providers}`],
      ["test", `-filter=${testPath}`],
    ]) {
      const result = spawnSync("tofu", [`-chdir=${directory}`, ...args], {
        stdio: "inherit",
        // The file names and tests are fixed; all external providers are mocked.
        // Plugin installation reads the existing pinned local mirror only.
        env: process.env,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Unknown-input OpenTofu ${args[0]} failed (${result.status ?? result.signal}).`);
      }
    }
    succeeded = true;
  } finally {
    if (succeeded) {
      rmSync(directory, { recursive: true });
    } else {
      console.error(`Retained failed synthetic fixture: ${directory}`);
    }
  }
}

if (import.meta.main) testUnknownInputs();
