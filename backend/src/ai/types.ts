import { ScoringResult } from '../scoring/rules.js';

/**
 * Input to AI analysis
 */
export interface AiInput {
  score: number;
  level: 'LOW' | 'MED' | 'HIGH';
  reasons: string[];
  changed_files: string[];
  file_diffs: FileDiff[];
}

/**
 * File diff snippet
 */
export interface FileDiff {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
}

/**
 * AI output schema
 */
export interface AiOutput {
  summary: string; // 1-2 sentences explaining why risky
  review_focus: string[]; // 3-5 bullets: what to review first
  test_suggestions: string[]; // 3-6 concrete tests to add/run
  rollback_risk: 'LOW' | 'MED' | 'HIGH'; // + 1 sentence
  confidence: number; // 0.0-1.0
  warnings?: string[]; // any uncertainty or missing info
}

/**
 * Full AI analysis result with metadata
 */
export interface AiAnalysisResult {
  output: AiOutput;
  model: string;
  prompt_version: string;
  created_at: Date;
}

