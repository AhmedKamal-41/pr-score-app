import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ApiError, parseResponse } from './api-error';
import type { PRDetail, PRListResponse, SessionResponse, StatsResponse } from './types';

export const SESSION_COOKIE = 'prs_session';

/** Backend base URL for server-side requests (never exposed to the browser). */
export function apiInternalUrl(): string {
  return (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

/**
 * Server-side fetch to the backend on behalf of the signed-in user: forwards
 * only the session cookie and never caches (responses are per-user and live).
 */
async function serverFetch<T>(path: string): Promise<T> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;
  const response = await fetch(`${apiInternalUrl()}${path}`, {
    cache: 'no-store',
    headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
  });
  return parseResponse<T>(response);
}

export const serverApi = {
  session: () => serverFetch<SessionResponse>('/api/auth/session'),
  prs: (limit: number, offset: number) => serverFetch<PRListResponse>(`/api/prs?limit=${limit}&offset=${offset}`),
  pr: (id: string) => serverFetch<PRDetail>(`/api/prs/${encodeURIComponent(id)}`),
  stats: () => serverFetch<StatsResponse>('/api/stats'),
  demoStatus: () => serverFetch<{ enabled: boolean }>('/api/demo/status'),
};

export type Settled<T> = { ok: true; data: T } | { ok: false; error: unknown };

/** Resolve a request to a value-or-error without throwing. */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Map API errors to navigation: 401 → login (returning here afterwards),
 * 404 → not-found page. Must be called outside try/catch: redirect() and
 * notFound() work by throwing. Returns normally for other errors, which the
 * page renders itself.
 */
export function navigateForApiError(error: unknown, currentPath: string): void {
  if (error instanceof ApiError) {
    if (error.status === 401) redirect(`/login?next=${encodeURIComponent(currentPath)}`);
    if (error.status === 404) notFound();
  }
}
