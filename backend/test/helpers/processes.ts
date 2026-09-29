import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  output: () => string;
  /** Send a signal and resolve with the exit code (null if killed by signal). */
  stop: (signal?: NodeJS.Signals, timeoutMs?: number) => Promise<number | null>;
}

export function startProcess(name: string, command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ManagedProcess {
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout?.on('data', (d) => (log += d.toString()));
  child.stderr?.on('data', (d) => (log += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    name,
    child,
    output: () => log,
    stop: async (signal = 'SIGTERM', timeoutMs = 30_000) => {
      if (child.exitCode !== null) return child.exitCode;
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

export async function waitForHttp(url: string, ok: (status: number) => boolean = (s) => s === 200, timeoutMs = 60_000, proc?: ManagedProcess): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (ok(res.status)) return;
    } catch {
      // not up yet
    }
    if (proc && proc.child.exitCode !== null) throw new Error(`${proc.name} exited early:\n${proc.output()}`);
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${url}${proc ? `\n${proc.output()}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function waitUntil<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000, describe = 'condition'): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (done(last)) return last;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${describe}; last: ${JSON.stringify(last, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
