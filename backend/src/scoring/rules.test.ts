import { describe, it, expect } from 'vitest';
import { computeScore, ScoringInput } from './rules.js';

describe('PR Scoring Rules', () => {
  // Test 1: Small PR - Few files, few lines → LOW score
  it('should score small PR as LOW', () => {
    const input: ScoringInput = {
      changed_files: 3,
      additions: 50,
      deletions: 20,
      changed_files_list: ['src/utils/helper.ts', 'src/index.ts', 'README.md'],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.level).toBe('LOW');
    expect(result.reasons.length).toBeLessThanOrEqual(3);
  });

  // Test 2: Huge PR - Many files (>50) → HIGH score
  it('should score huge PR (>50 files) as HIGH', () => {
    const input: ScoringInput = {
      changed_files: 55,
      additions: 200,
      deletions: 100,
      changed_files_list: Array.from({ length: 55 }, (_, i) => `src/file${i}.ts`),
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThan(70);
    expect(result.level).toBe('HIGH');
    expect(result.reasons.some((r) => r.includes('Large PR') && r.includes('files'))).toBe(true);
  });

  // Test 3: Large lines - >1000 lines changed → HIGH score
  it('should score PR with >1000 lines changed as HIGH', () => {
    const input: ScoringInput = {
      changed_files: 10,
      additions: 800,
      deletions: 300,
      changed_files_list: Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`),
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThan(70);
    expect(result.level).toBe('HIGH');
    expect(result.reasons.some((r) => r.includes('Large PR') && r.includes('lines'))).toBe(true);
  });

  // Test 4: Auth touched - Critical path (auth) → MED/HIGH score
  it('should score PR touching auth as MED or HIGH', () => {
    const input: ScoringInput = {
      changed_files: 5,
      additions: 100,
      deletions: 50,
      changed_files_list: [
        'src/auth/login.ts',
        'src/utils/helper.ts',
        'src/index.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(['MED', 'HIGH']).toContain(result.level);
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched).toContain('Authentication');
    expect(result.reasons.some((r) => r.includes('Authentication'))).toBe(true);
  });

  // Test 5: Payments touched - Critical path (payments) → MED/HIGH score
  it('should score PR touching payments as MED or HIGH', () => {
    const input: ScoringInput = {
      changed_files: 3,
      additions: 80,
      deletions: 30,
      changed_files_list: [
        'src/payments/processor.ts',
        'src/payments/billing.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(['MED', 'HIGH']).toContain(result.level);
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched).toContain('Payments');
  });

  // Test 6: No tests - Changes but no test files → MED score
  it('should score PR with no test changes as MED', () => {
    const input: ScoringInput = {
      changed_files: 5,
      additions: 150,
      deletions: 50,
      changed_files_list: [
        'src/feature.ts',
        'src/utils.ts',
        'src/index.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.features.has_test_changes).toBe(false);
    expect(result.reasons.some((r) => r.includes('No test files'))).toBe(true);
  });

  // Test 7: Tests added - Has test changes → Lower score
  it('should score PR with test changes lower', () => {
    const input: ScoringInput = {
      changed_files: 5,
      additions: 150,
      deletions: 50,
      changed_files_list: [
        'src/feature.ts',
        'src/feature.test.ts',
        'src/utils.ts',
        'tests/utils.spec.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.features.has_test_changes).toBe(true);
    // Should not have "No test files changed" reason
    expect(result.reasons.some((r) => r.includes('No test files'))).toBe(false);
  });

  // Test 8: Multiple risks - Big PR + critical paths + no tests → HIGH score
  it('should score PR with multiple risks as HIGH', () => {
    const input: ScoringInput = {
      changed_files: 25,
      additions: 600,
      deletions: 200,
      changed_files_list: [
        'src/auth/login.ts',
        'src/payments/processor.ts',
        ...Array.from({ length: 23 }, (_, i) => `src/file${i}.ts`),
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThan(70);
    expect(result.level).toBe('HIGH');
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched.length).toBeGreaterThan(1);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // Test 9: Config touched - Critical path (config) → MED score
  it('should score PR touching config as MED', () => {
    const input: ScoringInput = {
      changed_files: 2,
      additions: 30,
      deletions: 10,
      changed_files_list: [
        'src/config/settings.ts',
        'src/utils.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched).toContain('Configuration');
  });

  // Test 10: Migration touched - Critical path (migrations) → MED score
  it('should score PR touching migrations as MED', () => {
    const input: ScoringInput = {
      changed_files: 1,
      additions: 50,
      deletions: 5,
      changed_files_list: [
        'prisma/migrations/20240101000000_init/migration.sql',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched).toContain('Migrations');
  });

  // Test 11: GitHub Actions touched → MED score
  it('should score PR touching .github/ as MED', () => {
    const input: ScoringInput = {
      changed_files: 2,
      additions: 20,
      deletions: 5,
      changed_files_list: [
        '.github/workflows/ci.yml',
        'src/utils.ts',
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.features.touches_critical_paths).toBe(true);
    expect(result.features.critical_paths_touched).toContain('GitHub Actions');
  });

  // Test 12: Score capped at 100
  it('should cap score at 100', () => {
    const input: ScoringInput = {
      changed_files: 60,
      additions: 1200,
      deletions: 500,
      changed_files_list: [
        'src/auth/login.ts',
        'src/payments/processor.ts',
        'src/config/settings.ts',
        ...Array.from({ length: 57 }, (_, i) => `src/file${i}.ts`),
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.level).toBe('HIGH');
  });

  // Test 13: Top 3 reasons returned
  it('should return top 3 reasons', () => {
    const input: ScoringInput = {
      changed_files: 30,
      additions: 700,
      deletions: 300,
      changed_files_list: [
        'src/auth/login.ts',
        'src/payments/processor.ts',
        'src/config/settings.ts',
        ...Array.from({ length: 27 }, (_, i) => `src/file${i}.ts`),
      ],
    };
    
    const result = computeScore(input);
    
    expect(result.reasons.length).toBeLessThanOrEqual(3);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

