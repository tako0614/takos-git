import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageUnknownInputFixture } from "./test-managed-browser-unknown.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("unknown-input tests retain the real root and original oracles outside the installable tree", () => {
  const directory = stageUnknownInputFixture();
  try {
    for (const path of ["main.tf", "outputs.tf", "release.lock.json", ".terraform.lock.hcl"]) {
      expect(readFileSync(join(directory, path))).toEqual(readFileSync(join(repository, path)));
    }
    for (const path of [
      "tests/managed-browser-session-unknown.tftest.hcl",
      "tests/fixtures/managed-browser-session-unknown/main.tf",
    ]) {
      expect(existsSync(join(repository, path))).toBe(false);
      expect(readFileSync(join(directory, path))).toEqual(readFileSync(join(repository, `${path}.fixture`)));
    }
    const testFile = readFileSync(join(directory, "tests/managed-browser-session-unknown.tftest.hcl"), "utf8");
    expect(testFile.match(/^run "/gm)).toHaveLength(3);
    expect(testFile).toContain('command = apply');
    expect(readFileSync(join(directory, "tests/fixtures/managed-browser-session-unknown/main.tf"), "utf8"))
      .toContain('source = "../../.."');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
