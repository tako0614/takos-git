import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Git CLI fixtures do not invoke an inherited credential helper", async () => {
  expect(Bun.spawnSync(["git", "--version"]).exitCode).toBe(0);
  const root = await mkdtemp(join(tmpdir(), "takos-git-helper-isolation-"));
  const counter = join(root, "helper-called");
  const config = join(root, "fixture.gitconfig");
  // The sentinel records only invocation, never the credential protocol input.
  const quoted = "'" + counter.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  const helper = `!f() { echo called >> ${quoted}; }; f`;
  await writeFile(config, `[credential]\n\thelper = "${helper.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`, { mode: 0o600 });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Run the existing real Worker/HTTP clone case with a controlled hostile
    // ambient config. This uses only that case's existing synthetic broker.
    child = Bun.spawn([
      process.execPath, "test", "--no-install", "src/git-clone.test.ts",
      "--test-name-pattern", "works end-to-end against the standalone worker",
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    timer = setTimeout(() => child?.kill("SIGTERM"), 20_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
    expect(stderr).toContain("1 pass");
    expect(stderr).not.toContain("skipping");
    const called = await readFile(counter, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(called).toBe("");
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill("SIGTERM");await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
