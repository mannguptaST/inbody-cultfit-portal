'use client';

import type { TimelineStage } from '@/types';

interface Props {
  stages: TimelineStage[];
  currentStage: number;
}

const ICONS: Record<string, React.ReactNode> = {
  'shopping-cart': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  ),
  'file-text': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  'inbox': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
  ),
  'check-square': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  'truck': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
    </svg>
  ),
  'tool': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  'upload-cloud': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
  ),
  'mail': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ),
  'check-circle': (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

function CheckIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export default function OrderTimeline({ stages, currentStage }: Props) {
  return (
    <div className="w-full">
      {stages.map((stage, index) => {
        const isDone     = stage.status === 'done';
        const isRejected = stage.status === 'rejected';
        const isCurrent  = stage.stage === currentStage;
        const isFuture   = !isDone && !isRejected && !isCurrent;

        const formattedDate = stage.date
          ? new Date(stage.date).toLocaleDateString('en-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            })
          : null;

        return (
          <div key={stage.stage} className="flex gap-4 pb-7 last:pb-0">
            {/* Left: marker + connector */}
            <div className="flex flex-col items-center">
              <div
                className={`
                  w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 border-2
                  ${isDone
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : isRejected
                    ? 'bg-red-500 border-red-500 text-white'
                    : isCurrent
                    ? 'bg-white border-blue-600 text-blue-600'
                    : 'bg-white border-slate-200 text-slate-300'
                  }
                `}
              >
                {isDone
                  ? <CheckIcon />
                  : isRejected
                  ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                  : (ICONS[stage.icon] ?? <span className="text-xs font-bold">{stage.stage}</span>)
                }
              </div>
              {index < stages.length - 1 && (
                <div className={`w-px flex-1 mt-1.5 ${isDone ? 'bg-blue-200' : 'bg-slate-100'}`} style={{ minHeight: '24px' }} />
              )}
            </div>

            {/* Right: content */}
            <div className="flex-1 pt-1.5 pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className={`font-medium text-sm ${
                  isDone     ? 'text-slate-800'
                  : isRejected ? 'text-red-600'
                  : isCurrent  ? 'text-blue-700'
                  : 'text-slate-400'
                }`}>
                  {stage.label}
                </p>

                <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                  isDone     ? 'bg-blue-50 text-blue-700'
                  : isRejected ? 'bg-red-50 text-red-600'
                  : isCurrent  ? 'bg-blue-50 text-blue-600 border border-blue-100'
                  : 'bg-slate-50 text-slate-400'
                }`}>
                  {isDone ? 'Completed' : isRejected ? 'Rejected' : isCurrent ? 'In Progress' : 'Pending'}
                </span>
              </div>

              {formattedDate && (
                <p className="text-xs text-slate-400 mt-1">{formattedDate}</p>
              )}
              {!formattedDate && isDone && (
                <p className="text-xs text-slate-300 mt-1">Date not recorded</p>
              )}
              {isFuture && (
                <p className="text-xs text-slate-300 mt-1">Not started</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
