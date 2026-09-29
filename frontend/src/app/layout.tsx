import type { Metadata } from 'next';
import './globals.css';
import Nav from '@/components/Nav';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = {
  title: 'PR Risk Scorer',
  description: 'Deterministic pull request risk scoring with optional AI review',
};

// Every page depends on the signed-in session: always render per request.
export const dynamic = 'force-dynamic';

async function currentUser(): Promise<string | null> {
  try {
    const session = await serverApi.session();
    return session.authenticated ? session.username ?? null : null;
  } catch {
    return null; // API unreachable: pages show their own errors
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const username = await currentUser();
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <Nav username={username} />
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </body>
    </html>
  );
}
