import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

import LoginForm from '@/components/LoginForm';
import { safeNext } from '@/lib/safe-next';

function fill() {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-password' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
  });

  it('posts credentials as JSON to the same-origin proxy and navigates to the requested page', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginForm next="/stats" />);
    fill();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/stats'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ username: 'admin', password: 'secret-password' });
    vi.unstubAllGlobals();
  });

  it.each([
    [401, 'Invalid username or password.'],
    [429, 'Too many failed attempts. Try again later.'],
    [503, 'Sign-in is unavailable right now.'],
  ])('shows a clear message for HTTP %i', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'x', code: 'X', requestId: 'r' } }), { status })));
    render(<LoginForm />);
    fill();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('safeNext', () => {
  it('only allows same-site relative paths', () => {
    expect(safeNext('/prs/1')).toBe('/prs/1');
    expect(safeNext('//evil.example')).toBe('/prs');
    expect(safeNext('https://evil.example')).toBe('/prs');
    expect(safeNext('/\\evil.example')).toBe('/prs');
    expect(safeNext(undefined)).toBe('/prs');
  });
});
