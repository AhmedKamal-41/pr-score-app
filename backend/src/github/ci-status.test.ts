import { describe, it, expect } from 'vitest';
import { normalizeCi } from './ci-status.js';

const run = (conclusion: string | null, status = 'completed', appId = 1) => ({ status, conclusion, app: { id: appId } });

describe('normalizeCi', () => {
  it('reports unknown when no CI exists', () => {
    expect(normalizeCi([], [])).toMatchObject({ status: 'unknown', reason: 'no CI checks reported for this commit' });
  });

  it('reports success only when something passed and nothing failed or is running', () => {
    expect(normalizeCi([run('success'), run('skipped'), run('neutral')], [{ state: 'success' }]).status).toBe('success');
  });

  it.each(['failure', 'timed_out', 'action_required', 'startup_failure'])('treats a %s check as failure', (c) => {
    expect(normalizeCi([run('success'), run(c)], []).status).toBe('failure');
  });

  it.each(['failure', 'error'])('treats a %s commit status as failure', (state) => {
    expect(normalizeCi([run('success')], [{ state }]).status).toBe('failure');
  });

  it('reports pending while checks or statuses are incomplete', () => {
    expect(normalizeCi([run(null, 'in_progress'), run('success')], []).status).toBe('pending');
    expect(normalizeCi([run(null, 'queued')], []).status).toBe('pending');
    expect(normalizeCi([], [{ state: 'pending' }]).status).toBe('pending');
  });

  it('failure wins over pending', () => {
    expect(normalizeCi([run(null, 'in_progress'), run('failure')], []).status).toBe('failure');
  });

  it('treats only neutral/skipped checks as unknown', () => {
    expect(normalizeCi([run('skipped'), run('neutral')], [])).toMatchObject({ status: 'unknown', reason: 'only neutral or skipped checks' });
  });

  it('treats cancelled or stale runs as inconclusive', () => {
    expect(normalizeCi([run('cancelled')], [])).toMatchObject({ status: 'unknown', reason: 'CI runs were cancelled or inconclusive' });
    expect(normalizeCi([run('stale')], [])).toMatchObject({ status: 'unknown' });
  });

  it('does not claim success when a source is unreadable (missing permission)', () => {
    const r = normalizeCi('unavailable', [{ state: 'success' }]);
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/permission/);
    expect(r.details.check_runs).toBe('unavailable');
  });

  it('still reports failure seen through the readable source', () => {
    expect(normalizeCi('unavailable', [{ state: 'failure' }]).status).toBe('failure');
  });

  it("ignores this app's own check runs", () => {
    expect(normalizeCi([run('failure', 'completed', 777), run('success')], [], 777).status).toBe('success');
  });
});
