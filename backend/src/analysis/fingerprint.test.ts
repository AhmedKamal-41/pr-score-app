import { describe, it, expect } from 'vitest';
import { runFingerprint, stableStringify } from './fingerprint.js';

const base = {
  scoringVersion: 'v2',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  changedFiles: 2,
  additions: 10,
  deletions: 1,
  files: [
    { filename: 'b.ts', additions: 5, deletions: 0, status: 'modified' },
    { filename: 'a.ts', additions: 5, deletions: 1, status: 'added' },
  ],
  fileListComplete: true,
  ciStatus: 'pending',
};

describe('runFingerprint', () => {
  it('is independent of file order and object key order', () => {
    expect(runFingerprint(base)).toBe(runFingerprint({ ...base, files: [...base.files].reverse() }));
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('changes when CI changes on the same SHA', () => {
    expect(runFingerprint(base)).not.toBe(runFingerprint({ ...base, ciStatus: 'success' }));
  });

  it('changes with the head SHA, files or scoring version', () => {
    expect(runFingerprint(base)).not.toBe(runFingerprint({ ...base, headSha: 'b'.repeat(40) }));
    expect(runFingerprint(base)).not.toBe(runFingerprint({ ...base, files: base.files.slice(1) }));
    expect(runFingerprint(base)).not.toBe(runFingerprint({ ...base, scoringVersion: 'v3' }));
  });
});
