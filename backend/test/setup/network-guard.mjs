/**
 * Test-wide network guard: any TCP connection to a non-loopback host fails.
 * This covers fetch (undici), Octokit, the OpenAI SDK, ioredis and pg, so an
 * accidental real call to GitHub or OpenAI can never leave the machine.
 * Used as a Vitest setup file and preloaded (NODE_OPTIONS=--import) into the
 * API, worker and Next.js processes started by the end-to-end test.
 */
import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const originalConnect = net.Socket.prototype.connect;

function hostOf(args) {
  const first = args[0];
  if (Array.isArray(first)) return hostOf(first); // internal normalized-args form
  if (first && typeof first === 'object') {
    if (first.path) return undefined; // unix socket
    return first.host ?? 'localhost';
  }
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return undefined; // unix socket path
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = hostOf(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    throw new Error(`Network access to "${host}" is blocked during tests (use a local mock server)`);
  }
  return originalConnect.apply(this, args);
};
