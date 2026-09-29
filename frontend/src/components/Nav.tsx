import Link from 'next/link';
import LogoutButton from './LogoutButton';

const LINKS = [
  { href: '/prs', label: 'Pull Requests' },
  { href: '/stats', label: 'Statistics' },
];

export default function Nav({ username }: { username: string | null }) {
  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-bold text-gray-900">PR Risk Scorer</Link>
          <div className="hidden gap-6 sm:flex">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-sm font-medium text-gray-700 hover:text-gray-900">{l.label}</Link>
            ))}
          </div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          {username ? (
            <>
              <span className="text-sm text-gray-500">{username}</span>
              <LogoutButton />
            </>
          ) : (
            <Link href="/login" className="text-sm font-medium text-blue-600">Sign in</Link>
          )}
        </div>
        {/* Mobile menu: native disclosure, works without JavaScript. */}
        <details className="relative sm:hidden">
          <summary className="cursor-pointer list-none rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700" aria-label="Open menu">
            Menu
          </summary>
          <div className="absolute right-0 z-10 mt-2 w-48 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="block rounded px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">{l.label}</Link>
            ))}
            <div className="mt-2 border-t border-gray-100 px-3 pt-2">
              {username ? <LogoutButton /> : <Link href="/login" className="text-sm font-medium text-blue-600">Sign in</Link>}
            </div>
          </div>
        </details>
      </div>
    </nav>
  );
}
