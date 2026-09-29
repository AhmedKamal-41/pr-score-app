import { LEVEL_LABEL, LEVEL_STYLES, levelForScore } from '@/lib/levels';

interface ScoreBadgeProps {
  score: number | null;
  showScore?: boolean;
}

/** Level is always derived from the score with the shared boundaries. */
export default function ScoreBadge({ score, showScore = false }: ScoreBadgeProps) {
  if (score === null || Number.isNaN(score)) {
    return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">No score</span>;
  }
  const level = levelForScore(score);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${LEVEL_STYLES[level]}`}
      data-level={level}
    >
      {LEVEL_LABEL[level]}
      {showScore && ` (${score.toFixed(0)})`}
    </span>
  );
}
