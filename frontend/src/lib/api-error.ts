/** An HTTP error from the backend, preserving status and error code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope {
  error?: { message?: string; code?: string; requestId?: string };
}

/** Parse a backend response, throwing ApiError (with the real status) when it is not OK. */
export async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let body: Envelope = {};
  try {
    body = (await response.json()) as Envelope;
  } catch {
    // Non-JSON error body (proxy/network layer); fall back to the status line.
  }
  throw new ApiError(
    response.status,
    body.error?.code ?? `HTTP_${response.status}`,
    body.error?.message ?? `Request failed with status ${response.status}`,
    body.error?.requestId ?? response.headers.get('x-request-id'),
  );
}
