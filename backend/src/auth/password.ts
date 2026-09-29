import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (a memory-hard KDF recommended
 * by OWASP). Parameters follow OWASP guidance: N=2^17, r=8, p=1.
 *
 * Encoded format: scrypt$<log2 N>$<r>$<p>$<salt base64url>$<hash base64url>
 */

const KEY_LENGTH = 64;
const DEFAULT_LOG_N = 17;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN;
  // scrypt needs ~128 * N * r bytes; give it headroom above Node's 32 MiB default.
  return { N, r, p, maxmem: 256 * N * r };
}

export async function hashPassword(
  password: string,
  params: { logN?: number; r?: number; p?: number } = {},
): Promise<string> {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  const logN = params.logN ?? DEFAULT_LOG_N;
  const r = params.r ?? DEFAULT_R;
  const p = params.p ?? DEFAULT_P;
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, scryptOptions(logN, r, p));
  return ['scrypt', logN, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logNStr, rStr, pStr, saltB64, hashB64] = parts;
  const logN = Number(logNStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 22 || r < 1 || p < 1) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), scryptOptions(logN, r, p));
  return timingSafeEqual(actual, expected);
}
