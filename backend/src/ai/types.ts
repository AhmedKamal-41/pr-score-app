import type { RiskLevel } from '../scoring/rules.js';

/** A changed file's diff as fetched from GitHub. `patch` is null for binary or oversized files. */
export interface FileDiff {
  filename: string;
  patch: string | null;
  additions: number;
  deletions: number;
}

/** Input to the AI review. All PR-derived content is treated as untrusted data. */
export interface AiInput {
  score: number;
  level: RiskLevel;
  reasons: string[];
  /** Unscored inputs that limit confidence (pending CI, partial file list, …). */
  uncertainties?: string[];
  changed_files: string[];
  /** The selected risky files, in ranking order. */
  file_diffs: FileDiff[];
  /** Set when GitHub could not list every changed file. */
  file_list_incomplete?: { listed: number; expected: number };
}

/** Structured AI output. Model-reported; schema validity does not make it correct. */
export interface AiOutput {
  summary: string;
  review_focus: string[];
  test_suggestions: string[];
  rollback_risk: 'LOW' | 'MED' | 'HIGH';
  /** Self-reported by the model, 0.0–1.0. Not a calibrated probability. */
  confidence: number;
  warnings?: string[];
}

/** What the prompt could not include. Persisted with every analysis. */
export interface AiLimitations {
  diff_budget_chars: number;
  diff_chars_used: number;
  selected_files: string[];
  truncated_files: string[];
  omitted_files: string[];
  missing_patch_files: string[];
  changed_files_in_prompt: number;
  changed_files_omitted_from_prompt: number;
  file_list_incomplete: boolean;
  redactions: number;
}
