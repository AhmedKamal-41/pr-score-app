import { describe, it, expect } from 'vitest';
import { computeScore, levelForScore, SCORING_RULES, type ScoringInput } from './rules.js';

const files = (n: number, prefix = 'src/file') => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);

function input(overrides: Partial<ScoringInput>): ScoringInput {
  return {
    changed_files: 1,
    additions: 1,
    deletions: 0,
    changed_files_list: ['src/feature.test.ts'],
    ci_status: 'success',
    ...overrides,
  };
}

describe('PR scoring rules (contract v2)', () => {
  it('scores a small PR without tests as LOW (20)', () => {
    const result = computeScore(
      input({
        changed_files: 3,
        additions: 50,
        deletions: 20,
        changed_files_list: ['src/utils/helper.ts', 'src/index.ts', 'README.md'],
      }),
    );
    expect(result.score).toBe(20);
    expect(result.level).toBe('LOW');
    expect(result.reasons).toEqual(['No test files changed']);
  });

  // The legacy test expected >70/HIGH, but that relied on an "unknown CI"
  // penalty the input never supplied. A single +40 size penalty plus +20 for
  // no tests is 60, which is MED by the level boundaries.
  it('scores a huge PR (>50 files, no tests, nothing else) as 60/MED', () => {
    const result = computeScore(
      input({ changed_files: 55, additions: 200, deletions: 100, changed_files_list: files(55) }),
    );
    expect(result.score).toBe(60);
    expect(result.level).toBe('MED');
    expect(result.reasons[0]).toBe('Large PR: 55 files changed (threshold: 50)');
  });

  it('scores a PR with >1000 lines (no tests, nothing else) as 60/MED', () => {
    const result = computeScore(
      input({ changed_files: 10, additions: 800, deletions: 300, changed_files_list: files(10) }),
    );
    expect(result.score).toBe(60);
    expect(result.level).toBe('MED');
    expect(result.reasons[0]).toBe('Large PR: 1100 lines changed (threshold: 1000)');
  });

  it('flags authentication changes', () => {
    const result = computeScore(
      input({
        changed_files: 5,
        additions: 100,
        deletions: 50,
        changed_files_list: ['src/auth/login.ts', 'src/utils/helper.ts', 'src/index.ts'],
      }),
    );
    expect(result.score).toBe(40);
    expect(result.level).toBe('MED');
    expect(result.features.critical_paths_touched).toEqual(['Authentication']);
    expect(result.reasons).toContain('Touches critical area: Authentication');
  });

  it('flags payment changes', () => {
    const result = computeScore(
      input({
        changed_files: 3,
        additions: 80,
        deletions: 30,
        changed_files_list: ['src/payments/processor.ts', 'src/payments/billing.ts'],
      }),
    );
    expect(result.score).toBe(40);
    expect(result.features.critical_paths_touched).toEqual(['Payments']);
  });

  it('adds +20 when no test files change', () => {
    const result = computeScore(
      input({ changed_files: 5, additions: 150, deletions: 50, changed_files_list: ['src/feature.ts', 'src/utils.ts', 'src/index.ts'] }),
    );
    expect(result.score).toBe(20);
    expect(result.features.has_test_changes).toBe(false);
    expect(result.reasons).toContain('No test files changed');
  });

  it('does not add the no-test penalty when test files change', () => {
    const result = computeScore(
      input({
        changed_files: 5,
        additions: 150,
        deletions: 50,
        changed_files_list: ['src/feature.ts', 'src/feature.test.ts', 'src/utils.ts', 'tests/utils.spec.ts'],
      }),
    );
    expect(result.features.has_test_changes).toBe(true);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('scores a PR with multiple risks as HIGH', () => {
    const result = computeScore(
      input({
        changed_files: 25,
        additions: 600,
        deletions: 200,
        changed_files_list: ['src/auth/login.ts', 'src/payments/processor.ts', ...files(23)],
      }),
    );
    // +20 files, +20 lines, +40 two critical areas, +20 no tests
    expect(result.score).toBe(100);
    expect(result.level).toBe('HIGH');
    expect(result.features.critical_paths_touched).toEqual(['Authentication', 'Payments']);
  });

  it('flags configuration changes', () => {
    const result = computeScore(
      input({ changed_files: 2, additions: 30, deletions: 10, changed_files_list: ['src/config/settings.ts', 'src/utils.ts'] }),
    );
    expect(result.score).toBe(40);
    expect(result.features.critical_paths_touched).toEqual(['Configuration']);
  });

  it('flags migration changes', () => {
    const result = computeScore(
      input({ changed_files: 1, additions: 50, deletions: 5, changed_files_list: ['prisma/migrations/20240101000000_init/migration.sql'] }),
    );
    expect(result.score).toBe(40);
    expect(result.features.critical_paths_touched).toEqual(['Migrations']);
  });

  it('flags CI workflow changes (formerly "GitHub Actions")', () => {
    const result = computeScore(
      input({ changed_files: 2, additions: 20, deletions: 5, changed_files_list: ['.github/workflows/ci.yml', 'src/utils.ts'] }),
    );
    expect(result.score).toBe(40);
    expect(result.features.critical_paths_touched).toEqual(['CI/CD workflows']);
  });

  it('caps the score at 100 while keeping the raw total', () => {
    const result = computeScore(
      input({
        changed_files: 60,
        additions: 1200,
        deletions: 500,
        changed_files_list: ['src/auth/login.ts', 'src/payments/processor.ts', 'src/config/settings.ts', ...files(57)],
        ci_status: 'failure',
      }),
    );
    // 40 + 40 + 40 + 20 (no tests) + 20 (CI failure) = 160
    expect(result.features.raw_score).toBe(160);
    expect(result.score).toBe(100);
    expect(result.level).toBe('HIGH');
    expect(result.contributions.reduce((s, c) => s + c.points, 0)).toBe(160);
  });

  it('returns exactly the top three reasons, highest contribution first, and keeps all contributions', () => {
    const result = computeScore(
      input({
        changed_files: 30,
        additions: 700,
        deletions: 300,
        changed_files_list: ['src/auth/login.ts', 'src/payments/processor.ts', 'src/config/settings.ts', ...files(27)],
      }),
    );
    expect(result.reasons).toEqual([
      'Touches multiple critical areas: Authentication, Payments, Configuration',
      'Medium PR: 30 files changed (threshold: 20)',
      'Medium PR: 1000 lines changed (threshold: 500)',
    ]);
    expect(result.contributions.map((c) => c.rule)).toEqual(['critical_paths', 'files', 'lines', 'no_tests']);
  });
});

describe('boundaries', () => {
  const sizeOnly = (changed_files: number, lines: number) =>
    computeScore(
      input({
        changed_files,
        additions: lines,
        deletions: 0,
        // Always include a test so only the size rules contribute.
        changed_files_list: ['src/a.test.ts'],
      }),
    );

  it.each([
    [20, 0],
    [21, 20],
    [50, 20],
    [51, 40],
  ])('files=%i → %i points', (n, expected) => {
    expect(sizeOnly(n, 0).score).toBe(expected);
  });

  it.each([
    [500, 0],
    [501, 20],
    [1000, 20],
    [1001, 40],
  ])('lines=%i → %i points', (n, expected) => {
    expect(sizeOnly(1, n).score).toBe(expected);
  });

  it('counts additions and deletions together', () => {
    expect(computeScore(input({ additions: 300, deletions: 201, changed_files_list: ['a.test.ts'] })).score).toBe(20);
  });

  it.each([
    [0, 'LOW'],
    [30, 'LOW'],
    [31, 'MED'],
    [70, 'MED'],
    [71, 'HIGH'],
    [100, 'HIGH'],
  ] as const)('levelForScore(%i) = %s', (score, level) => {
    expect(levelForScore(score)).toBe(level);
  });

  it('exposes the documented thresholds', () => {
    expect(SCORING_RULES.SIZE).toEqual({ HIGH_FILES: 50, MED_FILES: 20, HIGH_LINES: 1000, MED_LINES: 500 });
    expect(SCORING_RULES.PENALTIES).toEqual({ HIGH: 40, MED: 20 });
    expect(SCORING_RULES.LEVELS).toEqual({ LOW: 30, MED: 70 });
  });
});

describe('CI status', () => {
  const withCi = (ci_status: ScoringInput['ci_status'], ci_reason?: string) =>
    computeScore(input({ ci_status, ci_reason }));

  it('adds 20 points for failure', () => {
    const r = withCi('failure');
    expect(r.score).toBe(20);
    expect(r.reasons).toEqual(['CI failed for this revision']);
    expect(r.uncertainties).toEqual([]);
  });

  it('adds nothing for success', () => {
    expect(withCi('success').score).toBe(0);
    expect(withCi('success').uncertainties).toEqual([]);
  });

  it.each(['pending', 'unknown'] as const)('adds nothing for %s but reports uncertainty', (status) => {
    const r = withCi(status, 'no checks configured');
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.uncertainties).toEqual([`CI status is ${status} (no checks configured); not scored`]);
  });
});

describe('critical areas and coverage', () => {
  it('deduplicates categories across files', () => {
    const r = computeScore(
      input({
        changed_files: 3,
        changed_files_list: ['src/auth/login.ts', 'src/auth/session.ts', 'lib/oauth/client.ts', 'x.test.ts'],
      }),
    );
    expect(r.features.critical_paths_touched).toEqual(['Authentication']);
    expect(r.score).toBe(20);
  });

  it('does not treat look-alike names as critical or as tests', () => {
    const r = computeScore(
      input({
        changed_files: 5,
        changed_files_list: ['src/author.ts', 'src/latest.ts', 'src/inspector.ts', 'contest/index.ts', 'docs/specification.md'],
      }),
    );
    expect(r.features.critical_paths_touched).toEqual([]);
    expect(r.features.has_test_changes).toBe(false);
    expect(r.score).toBe(20);
  });

  it('reports an incomplete file list as uncertainty without inventing penalties', () => {
    const r = computeScore(
      input({
        changed_files: 3500,
        changed_files_list: files(3000),
        coverage: { expected_files: 3500, listed_files: 3000, complete: false },
      }),
    );
    expect(r.features.files_analyzed).toBe(3000);
    expect(r.uncertainties.some((u) => u.includes('Only 3000 of 3500'))).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const i = input({ changed_files: 30, additions: 600, changed_files_list: ['src/auth/a.ts', 'infra/main.tf', ...files(28)] });
    expect(computeScore(i)).toEqual(computeScore(i));
  });
});
