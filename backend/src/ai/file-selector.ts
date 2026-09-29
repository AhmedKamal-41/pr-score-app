import { isCriticalFile } from '../scoring/paths.js';

export interface FileRiskScore {
  filename: string;
  risk_score: number;
  is_critical: boolean;
  churn: number;
}

/** Bonus for files in a critical area (same matcher as the scoring rules). */
export const CRITICAL_FILE_BONUS = 200;
export const MAX_AI_FILES = 3;

/**
 * Rank changed files for AI review: risk = 200 (critical-area bonus) + churn.
 * Ties break by filename so selection is deterministic. Returns at most 3.
 */
export function selectRiskyFiles(
  changedFiles: string[],
  fileChurn: Map<string, { additions: number; deletions: number }>,
  limit: number = MAX_AI_FILES,
): FileRiskScore[] {
  return changedFiles
    .map((filename) => {
      const churnData = fileChurn.get(filename) ?? { additions: 0, deletions: 0 };
      const churn = churnData.additions + churnData.deletions;
      const isCritical = isCriticalFile(filename);
      return { filename, risk_score: (isCritical ? CRITICAL_FILE_BONUS : 0) + churn, is_critical: isCritical, churn };
    })
    .sort((a, b) => b.risk_score - a.risk_score || a.filename.localeCompare(b.filename))
    .slice(0, limit);
}
