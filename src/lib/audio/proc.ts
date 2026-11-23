import { spawn } from "node:child_process";

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; stdoutBuf?: Buffer };

const MAX_CAPTURE = 2 * 1024 * 1024;

/**
 * Run a binary with an args ARRAY (never a shell string). stdout/stderr are captured (capped).
 * The process is killed on timeout or when `signal` aborts.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; binary?: boolean; maxBinary?: number; onStdout?: (text: string) => void } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    const bufs: Buffer[] = [];
    let bufLen = 0;
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(bin, args, { shell: false, windowsHide: true, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, stdoutBuf: opts.binary ? Buffer.concat(bufs) : undefined });
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      if (opts.onStdout) {
        opts.onStdout(d.toString("utf8"));
        return;
      }
      if (opts.binary) {
        if (bufLen < (opts.maxBinary ?? 8 * 1024 * 1024)) {
          bufs.push(d);
          bufLen += d.length;
        }
      } else if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
      else stderr = stderr.slice(-MAX_CAPTURE / 2) + d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}
