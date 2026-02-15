interface ScoreBadgeProps {
  score: number | null;
  level: string | null;
  showScore?: boolean;
}

export default function ScoreBadge({
  score,
  level,
  showScore = false,
}: ScoreBadgeProps) {
  if (!level) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
        No Score
      </span>
    );
  }

  const levelLower = level.toLowerCase();

  let bgColor = 'bg-gray-100';
  let textColor = 'text-gray-800';

  if (levelLower === 'low') {
    bgColor = 'bg-green-100';
    textColor = 'text-green-800';
  } else if (levelLower === 'medium' || levelLower === 'med') {
    bgColor = 'bg-yellow-100';
    textColor = 'text-yellow-800';
  } else if (levelLower === 'high') {
    bgColor = 'bg-red-100';
    textColor = 'text-red-800';
  }

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${bgColor} ${textColor}`}
    >
      {level.toUpperCase()}
      {showScore && score !== null && ` (${score.toFixed(1)})`}
    </span>
  );
}

