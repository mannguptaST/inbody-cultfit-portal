'use client';

import type { TimelineStage } from '@/types';

interface Props {
  stages: TimelineStage[];
  currentStage: number;
}

const ICONS: Record<string, string> = {
  'shopping-cart': '🛒',
  'file-text': '📄',
  'inbox': '📥',
  'check-square': '✅',
  'truck': '🚛',
  'tool': '🔧',
  'upload-cloud': '☁️',
  'mail': '📧',
  'check-circle': '✔️',
};

export default function OrderTimeline({ stages, currentStage }: Props) {
  return (
    <div className="w-full">
      {stages.map((stage, index) => {
        const isDone = stage.status === 'done';
        const isRejected = stage.status === 'rejected';
        const isCurrent = stage.stage === currentStage;
        const isPending = stage.status === 'pending';

        return (
          <div key={stage.stage} className="flex gap-4 pb-6 last:pb-0">
            {/* Left: connector line + circle */}
            <div className="flex flex-col items-center">
              <div
                className={`
                  w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 flex-shrink-0
                  ${isDone
                    ? 'bg-green-500 border-green-500 text-white'
                    : isRejected
                    ? 'bg-red-500 border-red-500 text-white'
                    : isCurrent
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-400'
                  }
                `}
              >
                {isDone ? '✓' : isRejected ? '✗' : stage.stage}
              </div>
              {/* Vertical line connecting stages */}
              {index < stages.length - 1 && (
                <div
                  className={`w-0.5 flex-1 mt-1 min-h-[24px] ${
                    isDone ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>

            {/* Right: stage info */}
            <div className="flex-1 pt-1.5 pb-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span
                  className={`font-semibold text-sm ${
                    isDone
                      ? 'text-green-700'
                      : isRejected
                      ? 'text-red-600'
                      : isCurrent
                      ? 'text-blue-700'
                      : 'text-gray-400'
                  }`}
                >
                  {ICONS[stage.icon] ?? '●'} {stage.label}
                </span>

                {/* Status badge */}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    isDone
                      ? 'bg-green-100 text-green-700'
                      : isRejected
                      ? 'bg-red-100 text-red-700'
                      : isCurrent
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {isDone ? 'Completed' : isRejected ? 'Rejected' : isCurrent ? 'In Progress' : 'Pending'}
                </span>
              </div>

              {/* Date */}
              {stage.date && (
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(stage.date).toLocaleDateString('en-IN', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </p>
              )}
              {!stage.date && isDone && (
                <p className="text-xs text-gray-400 mt-1">Date not recorded</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
