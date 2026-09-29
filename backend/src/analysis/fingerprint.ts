import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted recursively so equal inputs hash equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(typeof value === 'bigint' ? value.toString() : value);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Identity of one deterministic analysis: every input that can change the
 * score. Same revision + same CI + same files ⇒ same fingerprint (replays are
 * no-ops); a CI change on the same SHA ⇒ a new fingerprint and new history.
 */
export function runFingerprint(input: {
  scoringVersion: string;
  headSha: string;
  baseRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  files: { filename: string; additions: number; deletions: number; status: string }[];
  fileListComplete: boolean;
  ciStatus: string;
}): string {
  const files = [...input.files]
    .map((f) => [f.filename, f.status, f.additions, f.deletions])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return sha256(stableStringify({ ...input, files }));
}
