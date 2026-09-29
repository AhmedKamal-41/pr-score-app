'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postJson } from '@/lib/client-api';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await postJson('/api/auth/logout');
        } finally {
          router.push('/login');
          router.refresh();
        }
      }}
      className="text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50"
    >
      Sign out
    </button>
  );
}
