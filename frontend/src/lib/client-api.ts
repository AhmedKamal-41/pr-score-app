import { parseResponse } from './api-error';

/** Browser-side JSON POST through the same-origin /api proxy. */
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  return parseResponse<T>(response);
}
