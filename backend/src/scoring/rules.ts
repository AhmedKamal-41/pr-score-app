// Editable scoring rule constants
export const SCORING_RULES = {
  // PR Size thresholds
  SIZE: {
    HIGH_FILES: 50, // Files changed > 50 → HIGH risk
    MED_FILES: 20, // Files changed > 20 → MED risk
    HIGH_LINES: 1000, // Lines changed > 1000 → HIGH risk
    MED_LINES: 500, // Lines changed > 500 → MED risk
  },
  
  // Critical path patterns (case-insensitive)
  CRITICAL_PATHS: [
    { pattern: /auth|authentication|login|session/i, name: 'Authentication' },
    { pattern: /payment|payments|billing|invoice/i, name: 'Payments' },
    { pattern: /config|configuration|settings/i, name: 'Configuration' },
    { pattern: /infra|infrastructure|deploy|deployment/i, name: 'Infrastructure' },
    { pattern: /migration|migrations|schema/i, name: 'Migrations' },
    { pattern: /\.github\//i, name: 'GitHub Actions' },
  ],
  
  // Test file patterns
  TEST_PATTERNS: [
    /test/i,
    /spec/i,
    /__tests__/i,
    /tests\//i,
  ],
  
  // Score penalties
  PENALTIES: {
    HIGH: 40, // HIGH risk rule → +40 points
    MED: 20, // MED risk rule → +20 points
  },
  
  // Score level thresholds
  LEVELS: {
    LOW: 30, // 0-30: LOW
    MED: 70, // 31-70: MED
    // 71-100: HIGH
  },
} as const;

export interface ScoringInput {
  changed_files: number;
  additions: number;
  deletions: number;
  changed_files_list: string[];
  ci_status?: 'success' | 'failure' | 'pending' | 'unknown';
}

export interface ScoringResult {
  score: number; // 0-100
  level: 'LOW' | 'MED' | 'HIGH';
  reasons: string[]; // Top 3 reasons
  features: {
    files_changed: number;
    lines_changed: number;
    touches_critical_paths: boolean;
    critical_paths_touched: string[];
    has_test_changes: boolean;
    ci_status?: string;
  };
}

interface RuleResult {
  reason: string;
  severity: 'HIGH' | 'MED';
}

/**
 * Check if a file path matches test patterns
 */
function isTestFile(filePath: string): boolean {
  return SCORING_RULES.TEST_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Check if a file path touches critical paths
 */
function touchesCriticalPath(filePath: string): { touched: boolean; pathName: string | null } {
  for (const { pattern, name } of SCORING_RULES.CRITICAL_PATHS) {
    if (pattern.test(filePath)) {
      return { touched: true, pathName: name };
    }
  }
  return { touched: false, pathName: null };
}

/**
 * Compute PR risk score based on rules
 */
export function computeScore(input: ScoringInput): ScoringResult {
  const { changed_files, additions, deletions, changed_files_list, ci_status } = input;
  const lines_changed = additions + deletions;
  
  const rules: RuleResult[] = [];
  const criticalPathsTouched: string[] = [];
  let hasTestChanges = false;
  
  // Check each file for critical paths and test files
  for (const filePath of changed_files_list) {
    const criticalCheck = touchesCriticalPath(filePath);
    if (criticalCheck.touched && criticalCheck.pathName) {
      if (!criticalPathsTouched.includes(criticalCheck.pathName)) {
        criticalPathsTouched.push(criticalCheck.pathName);
      }
    }
    
    if (isTestFile(filePath)) {
      hasTestChanges = true;
    }
  }
  
  // Rule 1: Big PR size (files)
  if (changed_files > SCORING_RULES.SIZE.HIGH_FILES) {
    rules.push({
      reason: `Large PR: ${changed_files} files changed (threshold: ${SCORING_RULES.SIZE.HIGH_FILES})`,
      severity: 'HIGH',
    });
  } else if (changed_files > SCORING_RULES.SIZE.MED_FILES) {
    rules.push({
      reason: `Medium PR: ${changed_files} files changed (threshold: ${SCORING_RULES.SIZE.MED_FILES})`,
      severity: 'MED',
    });
  }
  
  // Rule 2: Big PR size (lines)
  if (lines_changed > SCORING_RULES.SIZE.HIGH_LINES) {
    rules.push({
      reason: `Large PR: ${lines_changed} lines changed (threshold: ${SCORING_RULES.SIZE.HIGH_LINES})`,
      severity: 'HIGH',
    });
  } else if (lines_changed > SCORING_RULES.SIZE.MED_LINES) {
    rules.push({
      reason: `Medium PR: ${lines_changed} lines changed (threshold: ${SCORING_RULES.SIZE.MED_LINES})`,
      severity: 'MED',
    });
  }
  
  // Rule 3: Critical paths touched
  if (criticalPathsTouched.length > 0) {
    const pathsList = criticalPathsTouched.join(', ');
    // Multiple critical paths = HIGH, single = MED
    if (criticalPathsTouched.length > 1) {
      rules.push({
        reason: `Touches multiple critical paths: ${pathsList}`,
        severity: 'HIGH',
      });
    } else {
      rules.push({
        reason: `Touches critical path: ${pathsList}`,
        severity: 'MED',
      });
    }
  }
  
  // Rule 4: No tests changed
  if (changed_files > 0 && !hasTestChanges) {
    rules.push({
      reason: 'No test files changed',
      severity: 'MED',
    });
  }
  
  // Rule 5: CI status (for future use)
  if (ci_status === 'failure' || ci_status === 'unknown') {
    rules.push({
      reason: `CI status: ${ci_status}`,
      severity: 'MED',
    });
  }
  
  // Calculate score
  let score = 0;
  for (const rule of rules) {
    if (rule.severity === 'HIGH') {
      score += SCORING_RULES.PENALTIES.HIGH;
    } else {
      score += SCORING_RULES.PENALTIES.MED;
    }
  }
  
  // Cap score at 100
  score = Math.min(score, 100);
  
  // Determine level
  let level: 'LOW' | 'MED' | 'HIGH';
  if (score <= SCORING_RULES.LEVELS.LOW) {
    level = 'LOW';
  } else if (score <= SCORING_RULES.LEVELS.MED) {
    level = 'MED';
  } else {
    level = 'HIGH';
  }
  
  // Get top 3 reasons (prioritize HIGH severity, then by order)
  const sortedRules = [...rules].sort((a, b) => {
    if (a.severity === 'HIGH' && b.severity !== 'HIGH') return -1;
    if (a.severity !== 'HIGH' && b.severity === 'HIGH') return 1;
    return 0;
  });
  
  const topReasons = sortedRules.slice(0, 3).map((r) => r.reason);
  
  return {
    score,
    level,
    reasons: topReasons,
    features: {
      files_changed: changed_files,
      lines_changed,
      touches_critical_paths: criticalPathsTouched.length > 0,
      critical_paths_touched: criticalPathsTouched,
      has_test_changes: hasTestChanges,
      ci_status,
    },
  };
}

