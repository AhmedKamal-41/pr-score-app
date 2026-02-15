import ScoreBadge from './ScoreBadge';
import { PRDetail } from '../lib/api';

interface PrDetailProps {
  pr: PRDetail;
}

export default function PrDetail({ pr }: PrDetailProps) {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const reasons =
    pr.latest_score?.reasons && Array.isArray(pr.latest_score.reasons)
      ? pr.latest_score.reasons
      : [];

  const changedFiles = pr.changed_files_list || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{pr.title}</h1>
        <div className="mt-2 flex items-center space-x-4 text-sm text-gray-500">
          <span>
            {pr.repository} #{pr.github_pr_id}
          </span>
          <span>•</span>
          <span>By {pr.author}</span>
          <span>•</span>
          <span className="capitalize">{pr.state}</span>
        </div>
      </div>

      {/* Score Section */}
      {pr.latest_score && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Risk Score
          </h2>
          <div className="flex items-center space-x-4">
            <ScoreBadge
              score={pr.latest_score.score}
              level={pr.latest_score.level}
              showScore={true}
            />
            <span className="text-sm text-gray-500">
              Last updated: {formatDate(pr.latest_score.created_at)}
            </span>
          </div>
        </div>
      )}

      {/* Reasons */}
      {reasons.length > 0 && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Risk Reasons
          </h2>
          <ul className="list-disc list-inside space-y-2">
            {reasons.map((reason: string, index: number) => (
              <li key={index} className="text-gray-700">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* PR Details */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Pull Request Details
        </h2>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-gray-500">Additions</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {pr.additions?.toLocaleString() ?? 'N/A'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Deletions</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {pr.deletions?.toLocaleString() ?? 'N/A'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Files Changed</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {pr.changed_files ?? 'N/A'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Base Branch</dt>
            <dd className="mt-1 text-sm text-gray-900">{pr.base_ref}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Head Branch</dt>
            <dd className="mt-1 text-sm text-gray-900">{pr.head_ref}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Created</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {formatDate(pr.created_at)}
            </dd>
          </div>
          {pr.merged_at && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Merged</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {formatDate(pr.merged_at)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Changed Files */}
      {changedFiles.length > 0 && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Changed Files ({changedFiles.length})
          </h2>
          <div className="max-h-96 overflow-y-auto">
            <ul className="space-y-1">
              {changedFiles.map((file, index) => (
                <li
                  key={index}
                  className="text-sm font-mono text-gray-700 bg-gray-50 px-3 py-2 rounded"
                >
                  {file}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Score History */}
      {pr.score_history.length > 0 && (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Score History
          </h2>
          <div className="space-y-3">
            {pr.score_history.map((score, index) => (
              <div
                key={index}
                className="flex items-center justify-between py-2 border-b border-gray-200 last:border-0"
              >
                <div className="flex items-center space-x-3">
                  <ScoreBadge
                    score={score.score}
                    level={score.level}
                    showScore={true}
                  />
                  <span className="text-sm text-gray-500">
                    {formatDate(score.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

