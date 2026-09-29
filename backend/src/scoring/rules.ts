import { SCORING_VERSION } from '../config/constants.js';
import { criticalCategoriesFor, isTestFile, type CriticalCategory } from './paths.js';

/**
 * Deterministic PR risk scoring, contract v2.
 *
 * Rules (a higher threshold replaces the lower one within the same rule):
 *   1. Files changed      > 20 → +20,  > 50 → +40
 *   2. Lines changed      > 500 → +20, > 1000 → +40   (additions + deletions)
 *   3. Critical areas     1 category → +20, 2+ categories → +40
 *   4. No test files changed (and at least one file changed) → +20
 *   5. CI status          failure → +20; success → 0;
 *                         pending / unknown → 0, reported as uncertainty
 * Score = min(100, sum). Levels: LOW ≤ 30, MED ≤ 70, HIGH > 70.
 *
 * Change from the legacy contract: "unknown" CI used to add +20 to every PR
 * because CI was never fetched. v2 uses fetched CI and only penalises failure.
 * Historical scores keep scoring_version = "legacy" and are not rewritten.
 *
 * A score is a review-prioritisation heuristic. It does not prove correctness,
 * and a changed test file does not prove test coverage.
 */

export const SCORING_RULES = {
  SIZE: {
    HIGH_FILES: 50,
    MED_FILES: 20,
    HIGH_LINES: 1000,
    MED_LINES: 500,
  },
  PENALTIES: {
    HIGH: 40,
    MED: 20,
  },
  LEVELS: {
    LOW: 30,
    MED: 70,
  },
  MAX_SCORE: 100,
  TOP_REASONS: 3,
} as const;

export type CiStatus = 'success' | 'failure' | 'pending' | 'unknown';
export type RiskLevel = 'LOW' | 'MED' | 'HIGH';
export type RuleId = 'files' | 'lines' | 'critical_paths' | 'no_tests' | 'ci';

export interface FileCoverage {
  /** File count reported by GitHub for the PR. */
  expected_files: number;
  /** Files actually listed (GitHub caps pull request file listings). */
  listed_files: number;
  complete: boolean;
}

export interface ScoringInput {
  changed_files: number;
  additions: number;
  deletions: number;
  changed_files_list: string[];
  ci_status: CiStatus;
  /** Optional detail explaining a pending/unknown CI state. */
  ci_reason?: string;
  coverage?: FileCoverage;
}

export interface RuleContribution {
  rule: RuleId;
  points: number;
  severity: 'HIGH' | 'MED';
  reason: string;
}

export interface ScoringResult {
  score: number;
  level: RiskLevel;
  /** Top three reasons, highest contribution first. */
  reasons: string[];
  /** Every rule that contributed points (explains the full score). */
  contributions: RuleContribution[];
  /** Inputs that were not scored but limit confidence (pending CI, partial file list…). */
  uncertainties: string[];
  scoring_version: string;
  features: {
    files_changed: number;
    lines_changed: number;
    files_analyzed: number;
    touches_critical_paths: boolean;
    critical_paths_touched: CriticalCategory[];
    has_test_changes: boolean;
    ci_status: CiStatus;
    raw_score: number;
  };
}

export function levelForScore(score: number): RiskLevel {
  if (score <= SCORING_RULES.LEVELS.LOW) return 'LOW';
  if (score <= SCORING_RULES.LEVELS.MED) return 'MED';
  return 'HIGH';
}

/** Database/API representation of a level. */
export function levelToApi(level: RiskLevel): 'low' | 'medium' | 'high' {
  return level === 'LOW' ? 'low' : level === 'MED' ? 'medium' : 'high';
}

const RULE_ORDER: readonly RuleId[] = ['files', 'lines', 'critical_paths', 'no_tests', 'ci'];

export function computeScore(input: ScoringInput): ScoringResult {
  const { changed_files, additions, deletions, changed_files_list, ci_status } = input;
  const linesChanged = additions + deletions;
  const { PENALTIES, SIZE } = SCORING_RULES;

  const categories = new Set<CriticalCategory>();
  let hasTestChanges = false;
  for (const file of changed_files_list) {
    for (const c of criticalCategoriesFor(file)) categories.add(c);
    if (isTestFile(file)) hasTestChanges = true;
  }
  const criticalList = [...categories];

  const contributions: RuleContribution[] = [];
  const high = (rule: RuleId, reason: string) =>
    contributions.push({ rule, points: PENALTIES.HIGH, severity: 'HIGH', reason });
  const med = (rule: RuleId, reason: string) =>
    contributions.push({ rule, points: PENALTIES.MED, severity: 'MED', reason });

  if (changed_files > SIZE.HIGH_FILES) {
    high('files', `Large PR: ${changed_files} files changed (threshold: ${SIZE.HIGH_FILES})`);
  } else if (changed_files > SIZE.MED_FILES) {
    med('files', `Medium PR: ${changed_files} files changed (threshold: ${SIZE.MED_FILES})`);
  }

  if (linesChanged > SIZE.HIGH_LINES) {
    high('lines', `Large PR: ${linesChanged} lines changed (threshold: ${SIZE.HIGH_LINES})`);
  } else if (linesChanged > SIZE.MED_LINES) {
    med('lines', `Medium PR: ${linesChanged} lines changed (threshold: ${SIZE.MED_LINES})`);
  }

  if (criticalList.length > 1) {
    high('critical_paths', `Touches multiple critical areas: ${criticalList.join(', ')}`);
  } else if (criticalList.length === 1) {
    med('critical_paths', `Touches critical area: ${criticalList[0]}`);
  }

  if (changed_files > 0 && !hasTestChanges) {
    med('no_tests', 'No test files changed');
  }

  const uncertainties: string[] = [];
  if (ci_status === 'failure') {
    med('ci', 'CI failed for this revision');
  } else if (ci_status === 'pending' || ci_status === 'unknown') {
    uncertainties.push(
      `CI status is ${ci_status}${input.ci_reason ? ` (${input.ci_reason})` : ''}; not scored`,
    );
  }

  if (input.coverage && !input.coverage.complete) {
    uncertainties.push(
      `Only ${input.coverage.listed_files} of ${input.coverage.expected_files} changed files could be listed; ` +
        'critical-area and test detection used the listed files only',
    );
  }

  const rawScore = contributions.reduce((sum, c) => sum + c.points, 0);
  const score = Math.min(rawScore, SCORING_RULES.MAX_SCORE);

  // Deterministic ordering: points desc, then fixed rule order.
  const ordered = [...contributions].sort(
    (a, b) => b.points - a.points || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );

  return {
    score,
    level: levelForScore(score),
    reasons: ordered.slice(0, SCORING_RULES.TOP_REASONS).map((c) => c.reason),
    contributions: ordered,
    uncertainties,
    scoring_version: SCORING_VERSION,
    features: {
      files_changed: changed_files,
      lines_changed: linesChanged,
      files_analyzed: changed_files_list.length,
      touches_critical_paths: criticalList.length > 0,
      critical_paths_touched: criticalList,
      has_test_changes: hasTestChanges,
      ci_status,
      raw_score: rawScore,
    },
  };
}
