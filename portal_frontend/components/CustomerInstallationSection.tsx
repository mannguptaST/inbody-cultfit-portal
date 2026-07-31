'use client';

import { useEffect, useState } from 'react';
import { getCustomerInstallationView } from '@/lib/api';
import { INSTALLATION_STATUS_LABELS, INSTALLATION_STATUS_VARIANT } from '@/lib/stage-config';
import StatusChip from '@/components/StatusChip';
import type { CustomerInstallationView } from '@/types';

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function CustomerInstallationSection({ requestId }: { requestId: number }) {
  const [view, setView] = useState<CustomerInstallationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getCustomerInstallationView(requestId)
      .then(setView)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load installation info.'))
      .finally(() => setLoading(false));
  }, [requestId]);

  if (loading) return null;
  if (error) return null; // non-critical section — fails quietly rather than breaking the whole request detail page
  if (!view) return null;

  const { installation } = view;
  const hasInstallationInfo = installation.status !== 'not_scheduled' || installation.scheduledDate || installation.installationNotes;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Installation</h2>

      {!hasInstallationInfo ? (
        <p className="text-sm text-slate-500">Installation has not been scheduled yet.</p>
      ) : (
        <div className="space-y-3">
          <StatusChip label={INSTALLATION_STATUS_LABELS[installation.status]} variant={INSTALLATION_STATUS_VARIANT[installation.status]} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {installation.scheduledDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Scheduled Date</p><p className="text-slate-700 mt-0.5">{fmtDate(installation.scheduledDate)}</p></div>}
            {installation.scheduledTime && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Scheduled Time</p><p className="text-slate-700 mt-0.5">{installation.scheduledTime}</p></div>}
            {installation.assignedCs && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Assigned CS</p><p className="text-slate-700 mt-0.5">{installation.assignedCs}</p></div>}
            {installation.completedOn && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Completed On</p><p className="text-slate-700 mt-0.5">{fmtDate(installation.completedOn)}</p></div>}
          </div>
          {installation.installationNotes && (
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide">Installation Notes</p>
              <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{installation.installationNotes}</p>
            </div>
          )}
          {installation.completionNotes && (
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide">Completion Notes</p>
              <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{installation.completionNotes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
