import { describe, it, expect } from 'vitest';
import { selectRiskyFiles } from './file-selector.js';

describe('selectRiskyFiles', () => {
  it('should prioritize critical path files', () => {
    const changedFiles = ['src/auth/login.ts', 'src/utils/helpers.ts'];
    const fileChurn = new Map([
      ['src/auth/login.ts', { additions: 10, deletions: 5 }],
      ['src/utils/helpers.ts', { additions: 50, deletions: 20 }],
    ]);

    const result = selectRiskyFiles(changedFiles, fileChurn);
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('src/auth/login.ts'); // Critical path should be first
    expect(result[0].is_critical).toBe(true);
  });

  it('should combine critical path weight and churn', () => {
    const changedFiles = [
      'src/auth/login.ts', // Critical, low churn
      'src/payment/processor.ts', // Critical, high churn
      'src/utils/helpers.ts', // Non-critical, very high churn
    ];
    const fileChurn = new Map([
      ['src/auth/login.ts', { additions: 10, deletions: 5 }],
      ['src/payment/processor.ts', { additions: 100, deletions: 50 }],
      ['src/utils/helpers.ts', { additions: 200, deletions: 100 }],
    ]);

    const result = selectRiskyFiles(changedFiles, fileChurn);
    expect(result).toHaveLength(3);
    // Payment should be first (critical + high churn)
    expect(result[0].filename).toBe('src/payment/processor.ts');
    expect(result[0].is_critical).toBe(true);
  });

  it('should return top 3 files', () => {
    const changedFiles = [
      'src/file1.ts',
      'src/file2.ts',
      'src/file3.ts',
      'src/file4.ts',
      'src/file5.ts',
    ];
    const fileChurn = new Map([
      ['src/file1.ts', { additions: 10, deletions: 5 }],
      ['src/file2.ts', { additions: 20, deletions: 10 }],
      ['src/file3.ts', { additions: 30, deletions: 15 }],
      ['src/file4.ts', { additions: 40, deletions: 20 }],
      ['src/file5.ts', { additions: 50, deletions: 25 }],
    ]);

    const result = selectRiskyFiles(changedFiles, fileChurn);
    expect(result).toHaveLength(3);
    expect(result[0].filename).toBe('src/file5.ts'); // Highest churn
  });

  it('should handle empty file list', () => {
    const result = selectRiskyFiles([], new Map());
    expect(result).toHaveLength(0);
  });

  it('should handle files with no churn data', () => {
    const changedFiles = ['src/auth/login.ts', 'src/utils/helpers.ts'];
    const fileChurn = new Map();

    const result = selectRiskyFiles(changedFiles, fileChurn);
    expect(result).toHaveLength(2);
    // Critical path files should still be prioritized
    expect(result[0].filename).toBe('src/auth/login.ts');
    expect(result[0].is_critical).toBe(true);
  });

  it('should calculate risk scores correctly', () => {
    const changedFiles = ['src/auth/login.ts', 'src/utils/helpers.ts'];
    const fileChurn = new Map([
      ['src/auth/login.ts', { additions: 10, deletions: 5 }],
      ['src/utils/helpers.ts', { additions: 50, deletions: 20 }],
    ]);

    const result = selectRiskyFiles(changedFiles, fileChurn);
    expect(result[0].risk_score).toBeGreaterThan(result[1].risk_score);
    expect(result[0].churn).toBe(15); // 10 + 5
    expect(result[1].churn).toBe(70); // 50 + 20
  });
});

