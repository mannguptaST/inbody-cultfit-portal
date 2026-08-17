'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getOrderRequestDetail, respondToPI, getPIDownloadUrl } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { STAGE_VARIANT, PI_STATUS_LABELS, PI_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import PoSection from '@/components/PoSection';
import CustomerInstallationSection from '@/components/CustomerInstallationSection';
import CustomerLogisticsSection from '@/components/CustomerLogisticsSection';
import type { PortalRequestDetail, CustomerPIView } from '@/types';

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

function fmtInr(n: number | null | undefined): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function RequestDetailPage() {
  const router = useRouter();
  const params = useParams();
  const requestId = Number(params.id);

  const [request, setRequest] = useState<PortalRequestDetail | null>(null);
  const [pi, setPi] = useState<CustomerPIView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [userName, setUserName] = useState('');

  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [comment, setComment] = useState('');
  const [responding, setResponding] = useState(false);
  const [respondError, setRespondError] = useState('');

  function load() {
    getOrderRequestDetail(requestId)
      .then(res => { const { pi: piView, ...rest } = res; setRequest(rest); setPi(piView); })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load request.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (isInBodyStaff(u.role)) { router.replace('/admin'); return; }
      setUserName(u.name ?? '');
    });
    if (!requestId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function handleRespond(action: 'confirm' | 'request_correction') {
    if (action === 'request_correction' && !comment.trim()) {
      setRespondError('Please describe what needs correcting.');
      return;
    }
    setResponding(true);
    setRespondError('');
    try {
      await respondToPI(requestId, action, comment.trim() || undefined);
      setShowCorrectionForm(false);
      setComment('');
      load();
    } catch (err: unknown) {
      setRespondError(err instanceof Error ? err.message : 'Failed to submit response.');
    } finally {
      setResponding(false);
    }
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
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Delivery Date</p>
                    <p className="text-sm font-semibold text-slate-700 mt-0.5">{fmtDate(d.requestedDeliveryDate ?? d.preferredDeliveryDate)}</p>
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
                  {d.cultfitCompany && (
                    <div>
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">CultFit Company</p>
                      <p className="text-sm text-slate-700 mt-0.5">{d.cultfitCompany}</p>
                    </div>
                  )}
                  {/* Contact is resolved server-side from the existing Odoo contact —
                      never customer-entered. Shown only when reliably found, never
                      as blank/fake fields. Falls back to the legacy customer-entered
                      values only for requests submitted before this change. */}
                  {d.contact && (d.contact.name || d.contact.phone || d.contact.email) ? (
                    <div>
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact (from Odoo)</p>
                      <p className="text-sm text-slate-700 mt-0.5">
                        {[d.contact.name, d.contact.phone, d.contact.email].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  ) : (d.contactName || d.contactPhone || d.contactEmail) ? (
                    <div>
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact</p>
                      <p className="text-sm text-slate-700 mt-0.5">
                        {[d.contactName, d.contactPhone, d.contactEmail].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  ) : null}
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

            {/* Proforma Invoice */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Proforma Invoice</h2>
                {pi && pi.status !== 'not_created' && (
                  <StatusChip label={PI_STATUS_LABELS[pi.status]} variant={PI_STATUS_VARIANT[pi.status]} />
                )}
              </div>

              {(!pi || pi.status === 'not_created' || !pi.snapshot) ? (
                <p className="text-sm text-slate-500">InBody is preparing your PI.</p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide">PI Number</p>
                      <p className="font-mono font-medium text-slate-800 mt-0.5">{pi.snapshot.quotationNumber}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide">Version</p>
                      <p className="text-slate-700 mt-0.5">V{pi.snapshot.version}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide">Published</p>
                      <p className="text-slate-700 mt-0.5">{fmtDate(pi.snapshot.publishedDate)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide">Valid Until</p>
                      <p className="text-slate-700 mt-0.5">{fmtDate(pi.snapshot.validityDate)}</p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                          <th className="py-2 pr-3">Product</th>
                          <th className="py-2 pr-3 text-right">Qty</th>
                          <th className="py-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {pi.snapshot.lineItems.map((l, i) => (
                          <tr key={i}>
                            <td className="py-2 pr-3 text-slate-700">[{l.code}] {l.name}</td>
                            <td className="py-2 pr-3 text-right text-slate-600">{l.quantity}</td>
                            <td className="py-2 text-right text-slate-700">{fmtInr(l.untaxedTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap gap-6 text-sm border-t border-slate-100 pt-3">
                    <p className="text-slate-500">Untaxed: <span className="text-slate-800 font-medium">{fmtInr(pi.snapshot.untaxedAmount)}</span></p>
                    <p className="text-slate-500">Tax: <span className="text-slate-800 font-medium">{fmtInr(pi.snapshot.taxAmount)}</span></p>
                    <p className="text-slate-500">Total: <span className="text-slate-900 font-semibold">{fmtInr(pi.snapshot.totalAmount)}</span></p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <a
                      href={getPIDownloadUrl(request.id)}
                      className="text-sm text-blue-600 hover:text-blue-700 border border-blue-200 hover:border-blue-300 bg-blue-50 px-4 py-2 rounded-lg transition-all"
                    >
                      Download PI
                    </a>

                    {pi.status === 'awaiting_confirmation' && !showCorrectionForm && (
                      <>
                        <button
                          onClick={() => handleRespond('confirm')}
                          disabled={responding}
                          className="bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                        >
                          Confirm PI
                        </button>
                        <button
                          onClick={() => setShowCorrectionForm(true)}
                          disabled={responding}
                          className="text-sm text-amber-700 hover:text-amber-800 border border-amber-200 hover:border-amber-300 bg-amber-50 px-4 py-2 rounded-lg transition-all"
                        >
                          Request Correction
                        </button>
                      </>
                    )}
                  </div>

                  {pi.status === 'awaiting_confirmation' && showCorrectionForm && (
                    <div className="border-t border-slate-100 pt-4 space-y-3">
                      <label className="text-xs font-medium text-slate-600 block">
                        What needs to be corrected? <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        rows={3}
                        value={comment}
                        onChange={e => setComment(e.target.value)}
                        maxLength={1000}
                        className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => handleRespond('request_correction')}
                          disabled={responding}
                          className="bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                        >
                          {responding ? 'Submitting...' : 'Submit Correction Request'}
                        </button>
                        <button onClick={() => { setShowCorrectionForm(false); setComment(''); }} className="text-sm text-slate-500 hover:text-slate-700">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {respondError && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{respondError}</p>}
                </div>
              )}
            </div>

            {/* Purchase Order (Phase 3) */}
            <PoSection requestId={request.id} piStatus={pi?.status} />

            {/* Logistics & Delivery (Phase 4) */}
            <CustomerLogisticsSection requestId={request.id} />

            {/* Installation (Phase 5) */}
            <CustomerInstallationSection requestId={request.id} />

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
                {request.salespersonPhone && (
                  <div className="flex items-center gap-2 pt-1">
                    <a
                      href={`tel:${request.salespersonPhone}`}
                      className="text-xs text-blue-600 hover:text-blue-700 border border-blue-200 hover:border-blue-300 bg-blue-50 px-3 py-1.5 rounded-lg transition-all"
                    >
                      Call
                    </a>
                    <a
                      href={`https://wa.me/${digitsOnly(request.salespersonPhone)}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-xs text-green-700 hover:text-green-800 border border-green-200 hover:border-green-300 bg-green-50 px-3 py-1.5 rounded-lg transition-all"
                    >
                      WhatsApp
                    </a>
                  </div>
                )}
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
