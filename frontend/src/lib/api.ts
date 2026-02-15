const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';

export interface PRListItem {
  id: string;
  github_pr_id: number;
  title: string;
  author: string;
  state: string;
  repository: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  created_at: string;
  latest_score: {
    score: number;
    level: string;
    reasons: unknown;
    created_at: string;
  } | null;
}

export interface PRListResponse {
  data: PRListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
}

export interface PRDetail {
  id: string;
  github_pr_id: number;
  title: string;
  author: string;
  state: string;
  repository: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  changed_files_list: string[] | null;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  latest_score: {
    score: number;
    level: string;
    reasons: unknown;
    features: unknown;
    created_at: string;
  } | null;
  score_history: Array<{
    score: number;
    level: string;
    created_at: string;
  }>;
}

export interface StatsResponse {
  total_prs: number;
  average_score: number;
  counts_by_level: {
    low: number;
    medium: number;
    high: number;
  };
  top_risky_folders: Array<{
    folder: string;
    pr_count: number;
    average_score: number;
  }>;
}

export interface ApiError {
  error: {
    message: string;
    code: string;
    requestId: string;
    details?: unknown;
  };
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      error: {
        message: `HTTP ${response.status}: ${response.statusText}`,
        code: 'HTTP_ERROR',
        requestId: 'unknown',
      },
    }));
    throw new Error(error.error.message);
  }

  return response.json();
}

export async function fetchPRs(
  limit = 50,
  offset = 0
): Promise<PRListResponse> {
  return fetchApi<PRListResponse>(
    `/api/prs?limit=${limit}&offset=${offset}`
  );
}

export async function fetchPRDetails(id: string): Promise<PRDetail> {
  return fetchApi<PRDetail>(`/api/prs/${id}`);
}

export async function fetchStats(): Promise<StatsResponse> {
  return fetchApi<StatsResponse>('/api/stats');
}

export interface SeedDemoResponse {
  success: boolean;
  message: string;
  prs_created: number;
}

export async function seedDemoData(secret: string): Promise<SeedDemoResponse> {
  return fetchApi<SeedDemoResponse>('/api/demo/seed', {
    method: 'POST',
    headers: {
      'X-Demo-Secret': secret,
    },
  });
}

