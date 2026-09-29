const FORWARD_REQUEST_HEADERS = ['cookie', 'origin', 'content-type', 'x-request-id', 'user-agent'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'set-cookie', 'x-request-id', 'retry-after'];

function apiBase(): string {
  return (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

/** Forward /api/* to the backend's /api/*, passing only the headers it needs. */
export async function forwardToBackend(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${apiBase()}${url.pathname}${url.search}`;
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: { message: 'The API server is unreachable', code: 'API_UNREACHABLE', requestId: null } },
      { status: 502 },
    );
  }
  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    if (name === 'set-cookie') {
      for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
      continue;
    }
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('cache-control', 'no-store');
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
}
