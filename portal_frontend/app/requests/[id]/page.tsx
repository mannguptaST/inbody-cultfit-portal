'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getOrderRequestDetail } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { STAGE_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { PortalRequestDetail } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const FUTURE_SECTIONS = [
  { key: 'pi', label: 'Proforma Invoice (PI)' },
  { key: 'po', label: 'Purchase Order (PO)' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'invoice', label: 'Invoice' },
  { key: 'installation', label: 'Installation' },
];

export default function RequestDetailPage() {
  const router = useRouter();
  const params = useParams();
  const requestId = Number(params.id);

  const [request, setRequest] = useState<PortalRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [userName, setUserName] = useState('');

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (isInBodyStaff(u.role)) { router.replace('/admin'); return; }
      setUserName(u.name ?? '');
    });
    if (!requestId) return;

    getOrderRequestDetail(requestId)
      .then(setRequest)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load request.'))
      .finally(() => setLoading(false));
  }, [requestId, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CUSTOMER" userName={userName} onLogout={handleLogout} backHref="/requests" backLabel="My Requests" />
      <div className="flex items-center justify-center py-32">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading request...</p>
        </div>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CUSTOMER" userName={userName} onLogout={handleLogout} backHref="/requests" backLabel="My Requests" />
      <div className="flex items-center justify-center py-32 px-4">
        <div className="bg-white border border-red-200 rounded-xl p-8 text-center max-w-sm">
          <p className="text-red-700 font-medium mb-4">{error}</p>
          <button onClick={() => router.back()} className="text-blue-600 text-sm hover:underline">Go back</button>
        </div>
      </div>
    </div>
  );

  if (!request) return null;
  const d = request.details;

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader
        role="CUSTOMER"
        userName={userName}
        onLogout={handleLogout}
        backHref="/requests"
        backLabel="My Requests"
        crumb={`REQ-${request.id}`}
      />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

        {/* Hero */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 font-mono">REQ-{request.id}</h1>
                <StatusChip label={request.portal_stage_label} variant={STAGE_VARIANT[request.portal_stage] ?? 'neutral'} />
              </div>
              <p className="text-slate-700 font-medium mt-2">{request.name}</p>
              {d && <p className="text-slate-500 text-sm mt-0.5">{d.deliveryAddress}</p>}
            </div>
            <div className="text-right flex-shrink-0 text-xs text-slate-400">
              <p>Submitted {fmtDate(request.created_date)}</p>
              <p className="mt-0.5">Last updated {fmtDate(request.last_updated)}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

          {/* Left: request details */}
          <div className="lg:col-span-2 space-y-6">

            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Request Details</h2>
              {d ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">COCO / FOFO</p>
                    <p className="text-sm font-semibold text-slate-700 mt-0.5">{d.cocoFofo}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Preferred Delivery Date</p>
                    <p className="text-sm font-semibold text-slate-700 mt-0.5">{fmtDate(d.preferredDeliveryDate)}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Main Product</p>
                    <p className="text-sm font-semibold text-slate-700 mt-0.5">
                      {d.mainProduct.code ? `[${d.mainProduct.code}] ` : ''}{d.mainProduct.name} × {d.quantity}
                    </p>
                  </div>
                  {d.includedProducts.length > 0 && (
                    <div className="sm:col-span-2">
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Included (Free)</p>
                      <p className="text-sm text-slate-600 mt-0.5">
                        {d.includedProducts.map(p => (p.code ? `[${p.code}] ` : '') + p.name).join(', ')}
                      </p>
                    </div>
                  )}
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Delivery Address</p>
                    <p className="text-sm text-slate-700 mt-0.5">{d.deliveryAddress}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact Person</p>
                    <p className="text-sm text-slate-700 mt-0.5">{d.contactName}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact Phone</p>
                    <p className="text-sm text-slate-700 mt-0.5">{d.contactPhone}</p>
                  </div>
                  {d.contactEmail && (
                    <div>
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact Email</p>
                      <p className="text-sm text-slate-700 mt-0.5">{d.contactEmail}</p>
                    </div>
                  )}
                  {d.notes && (
                    <div className="sm:col-span-2">
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Notes</p>
                      <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{d.notes}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">Request details are not available for this opportunity.</p>
              )}
            </div>

            {/* Future sections — disabled placeholders, no fake data */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Order Progress</h2>
              <div className="space-y-2">
                {FUTURE_SECTIONS.map(s => (
                  <div
                    key={s.key}
                    className="flex items-center justify-between px-4 py-3 bg-slate-50 border border-slate-100 rounded-lg opacity-60"
                  >
                    <span className="text-sm font-medium text-slate-500">{s.label}</span>
                    <span className="text-xs text-slate-400">Available after InBody processes the request.</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Timeline */}
            {request.timeline.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">History</h2>
                <div className="space-y-4">
                  {request.timeline.map((entry, i) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-slate-700">{entry.body}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{entry.author} · {fmtDateTime(entry.date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: sidebar */}
          <div className="space-y-5 lg:sticky lg:top-20">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Status</h2>
              <StatusChip label={request.portal_stage_label} variant={STAGE_VARIANT[request.portal_stage] ?? 'neutral'} />
              <div className="mt-4 space-y-2 text-xs text-slate-500">
                <p>Assigned representative: <span className="text-slate-700 font-medium">{request.salesperson ?? 'Not yet assigned'}</span></p>
                <p>Created: {fmtDate(request.created_date)}</p>
                <p>Last updated: {fmtDate(request.last_updated)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
