import { describe, expect, test } from "bun:test";

import type { ActionsJobDispatch, DispatchStep } from "../../../src/features/actions/runner/contract.ts";
import type { StepExecContract } from "../../../src/features/actions/dto.ts";
import {
  executeJob,
  shellArgv,
  type ArtifactClient,
  type CheckoutClient,
  type LogSink,
  type SpawnFn,
} from "./step-executor.ts";
import { spawnShell } from "./spawn-shell.ts";

async function makeWorkspace(): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? "/tmp"}/tg-exec-${crypto.randomUUID()}`;
  await Bun.write(`${dir}/.keep`, "");
  return dir;
}

function step(partial: Partial<StepExecContract> & { stepId: string; number: number }): DispatchStep {
  const { stepId, number, ...contract } = partial;
  return {
    stepId,
    number,
    contract: {
      run: null,
      uses: null,
      with: null,
      env: {},
      name: `step ${number}`,
      shell: null,
      "working-directory": null,
      "continue-on-error": false,
      "timeout-minutes": null,
      ...contract,
    },
  };
}

function dispatch(steps: DispatchStep[], extra: Partial<ActionsJobDispatch> = {}): ActionsJobDispatch {
  return {
    kind: "takos-git.actions-job@v1",
    runId: "run1",
    jobId: "job1",
    repoId: "repo1",
    repo: "acme/web",
    attempt: 1,
    checkout: { commit: "a".repeat(40), ref: "refs/takos-actions/run1" },
    job: { matrix: null },
    secrets: [],
    steps,
    timeoutMs: 60_000,
    callbackBaseUrl: "https://git.example",
    callbackToken: "t",
    ...extra,
  };
}

interface Recorder {
  readonly logs: string[];
  readonly checkouts: string[];
  readonly artifacts: Array<{ name: string; path: string }>;
  readonly deps: {
    checkout: CheckoutClient;
    artifacts: ArtifactClient;
    logs: LogSink;
    workspaceDir: string;
    defaultShell: string;
  };
}

function recorder(workspaceDir: string): Recorder {
  const logs: string[] = [];
  const checkouts: string[] = [];
  const artifacts: Array<{ name: string; path: string }> = [];
  return {
    logs,
    checkouts,
    artifacts,
    deps: {
      checkout: {
        async checkout(dest: string): Promise<void> {
          checkouts.push(dest);
        },
      },
      artifacts: {
        async upload(name: string, path: string): Promise<void> {
          artifacts.push({ name, path });
        },
      },
      logs: {
        async append(text: string): Promise<void> {
          logs.push(text);
        },
      },
      workspaceDir,
      defaultShell: "bash",
    },
  };
}

describe("shellArgv (pure)", () => {
  test("maps shells to GitHub-shaped argv", () => {
    expect(shellArgv(null, "bash", "echo x")).toEqual(["bash", "-e", "-o", "pipefail", "-c", "echo x"]);
    expect(shellArgv("sh", "bash", "echo x")).toEqual(["sh", "-e", "-c", "echo x"]);
    expect(shellArgv("python3", "bash", "print(1)")).toEqual(["python3", "-c", "print(1)"]);
  });
});

describe("executeJob — real shell", () => {
  test("runs a trivial run: step to success and streams its output", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(dispatch([step({ stepId: "s1", number: 1, run: "echo hi" })]), {
      ...rec.deps,
      spawn: spawnShell,
    });
    expect(out.conclusion).toBe("success");
    expect(out.steps[0]).toMatchObject({ conclusion: "success", exitCode: 0 });
    expect(rec.logs.join("")).toContain("hi");
  });

  test("a failing step fails the job and short-circuits the rest", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([
        step({ stepId: "s1", number: 1, run: "exit 3" }),
        step({ stepId: "s2", number: 2, run: "echo after" }),
      ]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.conclusion).toBe("failure");
    expect(out.steps[0]).toMatchObject({ conclusion: "failure", exitCode: 3 });
    expect(out.steps[1].conclusion).toBe("skipped");
    expect(rec.logs.join("")).not.toContain("after");
  });

  test("continue-on-error keeps the job alive after a failed step", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([
        step({ stepId: "s1", number: 1, run: "exit 1", "continue-on-error": true }),
        step({ stepId: "s2", number: 2, run: "echo second" }),
      ]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.conclusion).toBe("success");
    expect(out.steps[0].conclusion).toBe("failure");
    expect(out.steps[1].conclusion).toBe("success");
    expect(rec.logs.join("")).toContain("second");
  });

  test("secret values are injected as env and redacted from logs", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([step({ stepId: "s1", number: 1, run: 'printf %s "$MY_SECRET"' })], {
        secrets: [{ name: "MY_SECRET", value: "supersecret123" }],
      }),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.conclusion).toBe("success");
    const joined = rec.logs.join("");
    expect(joined).not.toContain("supersecret123");
    expect(joined).toContain("***");
  });

  test("uses: checkout invokes the checkout client", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([step({ stepId: "s1", number: 1, uses: "actions/checkout@v4" })]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.steps[0].conclusion).toBe("success");
    expect(rec.checkouts).toEqual([ws]);
  });

  test("uses: upload-artifact invokes the artifact client with the resolved path", async () => {
    const ws = await makeWorkspace();
    await Bun.write(`${ws}/dist/out.txt`, "artifact-bytes");
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([
        step({
          stepId: "s1",
          number: 1,
          uses: "actions/upload-artifact@v4",
          with: { name: "build", path: "dist/out.txt" },
        }),
      ]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.steps[0].conclusion).toBe("success");
    expect(rec.artifacts).toEqual([{ name: "build", path: `${ws}/dist/out.txt` }]);
  });

  test("an unsupported uses: fails the step with a clear message", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([step({ stepId: "s1", number: 1, uses: "actions/setup-node@v4" })]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.steps[0].conclusion).toBe("failure");
    expect(out.steps[0].errorMessage).toContain("unsupported action");
  });

  test("a timed-out step yields a timed_out conclusion (injected spawn)", async () => {
    const ws = await makeWorkspace();
    const rec = recorder(ws);
    const timeoutSpawn: SpawnFn = async () => ({ exitCode: null, timedOut: true });
    const out = await executeJob(dispatch([step({ stepId: "s1", number: 1, run: "sleep 999" })]), {
      ...rec.deps,
      spawn: timeoutSpawn,
    });
    expect(out.conclusion).toBe("timed_out");
    expect(out.steps[0].conclusion).toBe("timed_out");
  });

  test("working-directory and merged env reach the shell", async () => {
    const ws = await makeWorkspace();
    await Bun.write(`${ws}/sub/.keep`, "");
    const rec = recorder(ws);
    const out = await executeJob(
      dispatch([
        step({
          stepId: "s1",
          number: 1,
          run: 'printf "%s|%s" "$PWD" "$FOO"',
          "working-directory": "sub",
          env: { FOO: "bar", CI: "true" },
        }),
      ]),
      { ...rec.deps, spawn: spawnShell },
    );
    expect(out.conclusion).toBe("success");
    const joined = rec.logs.join("");
    expect(joined).toContain("/sub|bar");
  });
});

describe("spawnShell — real process timeout", () => {
  test("kills a long process at the timeout and reports timedOut", async () => {
    const started = Date.now();
    const result = await spawnShell({
      argv: ["sh", "-c", "sleep 5"],
      cwd: Bun.env.TMPDIR ?? "/tmp",
      env: {},
      timeoutMs: 200,
      onOutput: () => {},
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
