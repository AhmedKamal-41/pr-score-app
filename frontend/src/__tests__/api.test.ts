import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, parseResponse } from '@/lib/api-error';
import { forwardToBackend } from '@/lib/proxy';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('parseResponse', () => {
  it('preserves the HTTP status, code and request id', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'Authentication required', code: 'UNAUTHORIZED', requestId: 'abc' } }), { status: 401 });
    const error = await parseResponse(res).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication required', requestId: 'abc' });
  });

  it('handles non-JSON error bodies', async () => {
    const error = await parseResponse(new Response('<html>bad gateway</html>', { status: 502, headers: { 'x-request-id': 'rid' } })).catch((e) => e);
    expect(error).toMatchObject({ status: 502, code: 'HTTP_502', requestId: 'rid' });
  });
});

describe('forwardToBackend', () => {
  it('forwards only needed headers and returns Set-Cookie and status unchanged', async () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4000');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      expect(h.get('cookie')).toBe('prs_session=tok');
      expect(h.get('origin')).toBe('http://localhost:3000');
      expect(h.get('authorization')).toBeNull();
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'prs_session=new; Path=/; HttpOnly; SameSite=Lax');
      return new Response('{"authenticated":true}', { status: 201, headers });
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('http://localhost:3000/api/auth/login?x=1', {
      method: 'POST',
      headers: { cookie: 'prs_session=tok', origin: 'http://localhost:3000', 'content-type': 'application/json', authorization: 'Bearer leak' },
      body: '{"username":"a"}',
    });
    const res = await forwardToBackend(request);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.internal:4000/api/auth/login?x=1');
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual(['prs_session=new; Path=/; HttpOnly; SameSite=Lax']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 502 when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await forwardToBackend(new Request('http://localhost:3000/api/prs'));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('API_UNREACHABLE');
  });
});
