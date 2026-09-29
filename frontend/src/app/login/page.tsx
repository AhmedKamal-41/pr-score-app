import LoginForm from '@/components/LoginForm';
import { safeNext } from '@/lib/safe-next';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-sm rounded-lg bg-white p-8 shadow">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Sign in</h1>
      <LoginForm next={safeNext(next)} />
    </div>
  );
}
