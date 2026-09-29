'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api-error';
import { postJson } from '@/lib/client-api';
import { safeNext } from '@/lib/safe-next';

export default function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await postJson('/api/auth/login', { username: form.get('username'), password: form.get('password') });
      router.push(safeNext(next));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Too many failed attempts. Try again later.');
      else if (err instanceof ApiError && err.status === 401) setError('Invalid username or password.');
      else setError('Sign-in is unavailable right now.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Sign in">
      <div>
        <label htmlFor="username" className="block text-sm font-medium text-gray-700">Username</label>
        <input id="username" name="username" autoComplete="username" required className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
