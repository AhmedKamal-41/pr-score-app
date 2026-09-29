import type { ApiLevel } from './types';

/** The same boundaries as the backend scoring contract: LOW ≤ 30, MED ≤ 70, HIGH > 70. */
export function levelForScore(score: number): ApiLevel {
  if (score <= 30) return 'low';
  if (score <= 70) return 'medium';
  return 'high';
}

export const LEVEL_STYLES: Record<ApiLevel, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-100 text-red-800',
};

export const LEVEL_LABEL: Record<ApiLevel, string> = { low: 'LOW', medium: 'MED', high: 'HIGH' };
