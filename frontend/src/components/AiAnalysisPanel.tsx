import type { AiAnalysisView, AiState } from '@/lib/types';
import { formatDate, shortSha } from '@/lib/format';
import StatusPill from './StatusPill';

const STATUS_TEXT: Record<string, string> = {
  pending: 'AI analysis is pending for this revision.',
  disabled: 'AI analysis is disabled on this server. The deterministic score above is unaffected.',
  unavailable: 'The AI provider was unavailable for this revision. The deterministic score is still valid.',
  failed: 'The AI response was rejected (invalid or unsafe output). The deterministic score is still valid.',
  superseded: 'A newer revision replaced this one before AI analysis finished.',
  missing: 'This revision has not been analysed by AI yet.',
  stale: 'No AI analysis exists for the current revision. The last analysis below is for an older revision.',
};

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Analysis({ view }: { view: AiAnalysisView }) {
  const a = view.analysis;
  const l = view.limitations;
  const limits = [
    ...(l?.truncated_files?.length ? [`Truncated diffs: ${l.truncated_files.join(', ')}`] : []),
    ...(l?.omitted_files?.length ? [`Omitted diffs (budget): ${l.omitted_files.join(', ')}`] : []),
    ...(l?.missing_patch_files?.length ? [`No diff available (binary or too large): ${l.missing_patch_files.join(', ')}`] : []),
    ...(l?.changed_files_omitted_from_prompt ? [`${l.changed_files_omitted_from_prompt} changed file names were not sent`] : []),
    ...(l?.file_list_incomplete ? ['GitHub could not list every changed file'] : []),
    ...(l?.note ? [l.note] : []),
  ];
  return (
    <div className="space-y-4">
      {/* All model text is rendered as plain text (React escapes it); nothing is executed. */}
      <p className="text-sm text-gray-800">{a.summary}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <List title="Review focus" items={a.review_focus} />
        <List title="Suggested tests" items={a.test_suggestions} />
      </div>
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-gray-500">Rollback risk (model estimate)</dt>
          <dd className="font-medium text-gray-900">{a.rollback_risk}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Model-reported confidence</dt>
          <dd className="font-medium text-gray-900">{Math.round(a.confidence * 100)}%</dd>
        </div>
        <div>
          <dt className="text-gray-500">Analyzed revision</dt>
          <dd className="font-mono text-gray-900">{shortSha(view.head_sha)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Generated</dt>
          <dd className="text-gray-900">{formatDate(view.created_at)}</dd>
        </div>
      </dl>
      {(a.warnings?.length ?? 0) > 0 && <List title="Model warnings" items={a.warnings!} />}
      {limits.length > 0 && <List title="Limitations" items={limits} />}
      <p className="text-xs text-gray-500">
        Model: {view.model} (prompt {view.prompt_version}). AI output is advisory and can be wrong; confidence is reported by the model, not measured.
      </p>
    </div>
  );
}

export default function AiAnalysisPanel({ ai, processing }: { ai: AiState; processing: boolean }) {
  return (
    <section className="rounded-lg bg-white p-6 shadow" aria-labelledby="ai-heading">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id="ai-heading" className="text-lg font-semibold text-gray-900">AI review</h2>
        <StatusPill label={ai.status} />
        {processing && <StatusPill label="processing" />}
        {ai.comment_status && ai.comment_status !== 'disabled' && <StatusPill label={`PR comment: ${ai.comment_status}`} tone={ai.comment_status} />}
      </div>
      {ai.current ? (
        <Analysis view={ai.current} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">{STATUS_TEXT[ai.status] ?? `AI status: ${ai.status}`}</p>
          {ai.error && <p className="text-sm text-red-600">Last error: {ai.error}</p>}
          {ai.previous && (
            <div className="rounded-md border border-dashed border-gray-300 p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Previous analysis — revision {shortSha(ai.previous.head_sha)} (not the current head)
              </p>
              <Analysis view={ai.previous} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
