/**
 * Minimal ambient declaration of the Bun APIs the runner container program uses.
 *
 * The container is a standalone Bun program (not the Worker bundle), so it may use
 * `Bun.spawn` / `Bun.serve` / `Bun.file` / `Bun.write`. takos-git's tsconfig sets
 * `types: []`, so these are declared narrowly here rather than pulling in
 * `bun-types`. Only the surface the executor touches is declared.
 */

interface BunSubprocess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

interface BunFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
  readonly size: number;
}

interface BunServer {
  stop(closeActiveConnections?: boolean): void;
  readonly port: number;
}

interface ImportMeta {
  /** True when this module is the process entrypoint (Bun extension). */
  readonly main: boolean;
}

declare const Bun: {
  spawn(options: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdout?: "pipe" | "inherit" | "ignore";
    stderr?: "pipe" | "inherit" | "ignore";
    stdin?: "pipe" | "inherit" | "ignore";
  }): BunSubprocess;
  serve(options: {
    port?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
  file(path: string): BunFile;
  write(path: string, data: string | Uint8Array | ArrayBuffer | Blob): Promise<number>;
  readonly env: Record<string, string | undefined>;
};
