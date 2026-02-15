import { SCORING_RULES } from '../scoring/rules.js';

export interface FileRiskScore {
  filename: string;
  risk_score: number;
  is_critical: boolean;
  churn: number;
}

/**
 * Check if a file path touches critical paths
 */
function touchesCriticalPath(filePath: string): boolean {
  return SCORING_RULES.CRITICAL_PATHS.some(({ pattern }) => pattern.test(filePath));
}

/**
 * Select top 3 most risky files based on combined score:
 * - Critical path weight: 2x
 * - Churn weight: 1x (additions + deletions)
 */
export function selectRiskyFiles(
  changedFiles: string[],
  fileChurn: Map<string, { additions: number; deletions: number }>
): FileRiskScore[] {
  const scoredFiles: FileRiskScore[] = changedFiles.map((filename) => {
    const churn = fileChurn.get(filename) || { additions: 0, deletions: 0 };
    const churnScore = churn.additions + churn.deletions;
    const isCritical = touchesCriticalPath(filename);
    
    // Combined score: critical path weight (2x) + churn weight (1x)
    const riskScore = (isCritical ? 2 : 0) * 100 + churnScore;
    
    return {
      filename,
      risk_score: riskScore,
      is_critical: isCritical,
      churn: churnScore,
    };
  });

  // Sort by risk score (descending) and take top 3
  return scoredFiles
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 3);
}

