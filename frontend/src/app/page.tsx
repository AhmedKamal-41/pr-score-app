import Link from 'next/link';

export default function Home() {
  return (
    <div className="py-8 text-center">
      <h1 className="mb-3 text-3xl font-bold text-gray-900">PR Risk Scorer</h1>
      <p className="mb-10 text-gray-600">Deterministic risk scores for pull requests, with optional AI review.</p>
      <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
        <Link href="/prs" className="rounded-lg bg-white p-6 shadow hover:shadow-md">
          <h2 className="font-semibold text-gray-900">Pull requests</h2>
          <p className="mt-1 text-sm text-gray-500">Scores, reasons, CI state and AI review per revision</p>
        </Link>
        <Link href="/stats" className="rounded-lg bg-white p-6 shadow hover:shadow-md">
          <h2 className="font-semibold text-gray-900">Statistics</h2>
          <p className="mt-1 text-sm text-gray-500">Risk distribution and riskiest folders</p>
        </Link>
      </div>
    </div>
  );
}
