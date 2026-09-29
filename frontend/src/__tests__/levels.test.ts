import { describe, it, expect } from 'vitest';
import { levelForScore } from '@/lib/levels';

describe('levelForScore (shared with the backend contract)', () => {
  it.each([
    [0, 'low'],
    [30, 'low'],
    [30.5, 'medium'],
    [31, 'medium'],
    [70, 'medium'],
    [71, 'high'],
    [100, 'high'],
  ] as const)('%s → %s', (score, level) => {
    expect(levelForScore(score)).toBe(level);
  });
});
