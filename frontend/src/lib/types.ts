/** API contract of the backend (see backend/src/api/pr-views.ts). */

export type ApiLevel = 'low' | 'medium' | 'high';
export type RevisionStatus = 'current' | 'previous_head' | 'legacy_unknown';
export type AiStatus = 'pending' | 'disabled' | 'succeeded' | 'unavailable' | 'failed' | 'superseded' | 'missing' | 'stale';

export interface Coverage {
  complete: boolean | null;
  expected_files: number | null;
  listed_files: number | null;
  files_without_patch: number | null;
  reason: string | null;
}

export interface ScoreView {
  score: number;
  level: ApiLevel;
  reasons: string[];
  contributions: { rule: string; points: number; severity: string; reason: string }[] | null;
  uncertainties: string[];
  coverage: Coverage | null;
  features: Record<string, unknown> | null;
  ci_status: string | null;
  head_sha: string | null;
  scoring_version: string;
  revision_status: RevisionStatus;
  created_at: string;
}

export interface PRBase {
  id: string;
  number: number | null;
  /** @deprecated alias of `number` */
  github_pr_id: number | null;
  github_id: string | null;
  identity_status: string;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  merged: boolean;
  repository: string;
  repository_private: boolean | null;
  repository_visibility: string | null;
  is_demo: boolean;
  head_sha: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  created_at: string;
  updated_at: string;
  github_created_at: string | null;
  github_updated_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
}

export interface PRListItem extends PRBase {
  latest_score: ScoreView | null;
  ai_status: AiStatus;
  processing: boolean;
}

export interface PRListResponse {
  data: PRListItem[];
  pagination: { limit: number; offset: number; total: number; has_more: boolean };
}

export interface AiOutput {
  summary: string;
  review_focus: string[];
  test_suggestions: string[];
  rollback_risk: 'LOW' | 'MED' | 'HIGH';
  confidence: number;
  warnings?: string[];
}

export interface AiLimitations {
  diff_budget_chars?: number;
  diff_chars_used?: number;
  selected_files?: string[];
  truncated_files?: string[];
  omitted_files?: string[];
  missing_patch_files?: string[];
  changed_files_omitted_from_prompt?: number;
  file_list_incomplete?: boolean;
  redactions?: number;
  note?: string;
}

export interface AiAnalysisView {
  analysis: AiOutput;
  model: string;
  prompt_version: string;
  head_sha: string | null;
  revision_status: RevisionStatus;
  limitations: AiLimitations | null;
  created_at: string;
}

export interface AiState {
  enabled: boolean;
  status: AiStatus;
  error: string | null;
  comment_status: string | null;
  analyzed_sha: string | null;
  run_created_at: string | null;
  current: AiAnalysisView | null;
  previous: AiAnalysisView | null;
}

export interface PRDetail extends PRBase {
  changed_files_list: string[];
  base_ref: string;
  head_ref: string;
  processing: boolean;
  latest_score: ScoreView | null;
  score_history: {
    score: number;
    level: ApiLevel;
    head_sha: string | null;
    ci_status: string | null;
    scoring_version: string;
    revision_status: RevisionStatus;
    created_at: string;
  }[];
  ai: AiState;
}

export interface StatsResponse {
  total_prs: number;
  scored_prs: number;
  unscored_prs: number;
  average_score: number | null;
  counts_by_level: { low: number; medium: number; high: number };
  top_risky_folders: { folder: string; pr_count: number; average_score: number; level: ApiLevel }[];
}

export interface SessionResponse {
  authenticated: boolean;
  username?: string;
}
