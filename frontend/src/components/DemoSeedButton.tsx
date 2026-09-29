'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '@/lib/api-error';
import { postJson } from '@/lib/client-api';

/** Development-only demo seeding; authorized by the admin session, no browser secret. */
export default function DemoSeedButton() {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; message: string | null; ok: boolean }>({ busy: false, message: null, ok: true });
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true, message: null, ok: true });
          try {
            const result = await postJson<{ message: string }>('/api/demo/seed');
            setState({ busy: false, message: result.message, ok: true });
            router.refresh();
          } catch (err) {
            setState({ busy: false, message: err instanceof ApiError ? err.message : 'Failed to load demo data', ok: false });
          }
        }}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {state.busy ? 'Loading demo data…' : 'Load demo data'}
      </button>
      {state.message && <p role="status" className={`text-sm ${state.ok ? 'text-green-700' : 'text-red-600'}`}>{state.message}</p>}
    </div>
  );
}
