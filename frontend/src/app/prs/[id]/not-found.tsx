import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-12 text-center">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Pull request not found</h1>
      <p className="mb-8 text-gray-600">It does not exist, or it belongs to a repository outside this workspace.</p>
      <Link href="/prs" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Back to pull requests</Link>
    </div>
  );
}
