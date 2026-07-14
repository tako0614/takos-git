/**
 * Production `SpawnFn` for the runner container: spawn a shell process with
 * `Bun.spawn`, stream merged stdout+stderr, and enforce a hard timeout by killing
 * the process. Isolated from the pure step loop so the loop stays runtime-free and
 * unit-testable with an injected spawn.
 */

import type { CommandResult, SpawnFn, SpawnOptions } from "./step-executor.ts";

async function pump(stream: ReadableStream<Uint8Array>, onOutput: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) onOutput(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onOutput(tail);
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const spawnShell: SpawnFn = async (options: SpawnOptions): Promise<CommandResult> => {
  const child = Bun.spawn({
    cmd: [...options.argv],
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);

  // Drain both pipes best-effort. They are NOT awaited before the process exits:
  // a killed shell can leave an orphaned child holding the pipe open, so we key
  // completion off the process exit and only briefly drain any buffered tail.
  const drained = Promise.all([
    pump(child.stdout, options.onOutput).catch(() => undefined),
    pump(child.stderr, options.onOutput).catch(() => undefined),
  ]);

  try {
    const exitCode = await child.exited;
    // Give the pumps a short grace to flush buffered output, but never hang on an
    // orphaned pipe.
    await Promise.race([drained, delay(250)]);
    return { exitCode: timedOut ? null : exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
};
