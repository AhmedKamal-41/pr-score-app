import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Pull Request Not Found
          </h1>
          <p className="text-lg text-gray-600 mb-8">
            The pull request you're looking for doesn't exist or has been removed.
          </p>
          <Link
            href="/prs"
            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            Back to Pull Requests
          </Link>
        </div>
      </div>
    </div>
  );
}

