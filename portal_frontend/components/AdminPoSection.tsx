'use client';

import { useState } from 'react';
import { approvePo, requestPoCorrection } from '@/lib/api';
import { PO_STATUS_LABELS, PO_STATUS_VARIANT } from '@/lib/stage-config';
import StatusChip from '@/components/StatusChip';
import type { PoAdminView, ComparisonResult } from '@/types';

function fmtInr(n: number | null): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function WarningRow({ w }: { w: ComparisonResult }) {
  const isMatch = w.severity === 'match';
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`text-xs px-2 py-0.5 rounded border ${isMatch ? 'text-green-700 bg-green-50 border-green-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
        {isMatch ? 'Match' : w.severity.replace(/_/g, ' ')}
      </span>
      <span className="text-slate-600">{w.message}</span>
    </div>
  );
}

export default function AdminPoSection({ requestId, po, onChange }: { requestId: number; po: PoAdminView; onChange: () => void }) {
  const [correctionComment, setCorrectionComment] = useState('');
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionWarning, setActionWarning] = useState('');

  async function handleApprove() {
    if (!confirm('Approve this PO? The customer will no longer be able to edit or resubmit.')) return;
    setBusy(true);
    setActionError('');
    setActionWarning('');
    try {
      await approvePo(requestId);
      onChange();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve PO.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestCorrection() {
    if (!correctionComment.trim()) {
      setActionError('Please describe what needs correcting.');
      return;
    }
    setBusy(true);
    setActionError('');
    setActionWarning('');
    try {
      const result = await requestPoCorrection(requestId, correctionComment.trim());
      if (result.warning) setActionWarning(result.warning);
      setShowCorrectionForm(false);
      setCorrectionComment('');
      onChange();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to request correction.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Purchase Order</h2>
        <StatusChip label={PO_STATUS_LABELS[po.status]} variant={PO_STATUS_VARIANT[po.status]} />
      </div>

      {!po.piConfirmed && <p className="text-sm text-slate-500">PO review will be available once the PI is confirmed.</p>}

      {po.piConfirmed && po.status === 'awaiting_upload' && (
        <p className="text-sm text-slate-500">Awaiting the customer to upload and submit a PO.</p>
      )}

      {po.latestSubmission && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><p className="text-xs text-slate-400 uppercase tracking-wide">PO Number</p><p className="font-mono text-slate-800 mt-0.5">{po.latestSubmission.data.poNumber}</p></div>
            <div><p className="text-xs text-slate-400 uppercase tracking-wide">PO Date</p><p className="text-slate-700 mt-0.5">{fmtDate(po.latestSubmission.data.poDate)}</p></div>
            <div><p className="text-xs text-slate-400 uppercase tracking-wide">Version</p><p className="text-slate-700 mt-0.5">V{po.latestSubmission.version}</p></div>
            <div><p className="text-xs text-slate-400 uppercase tracking-wide">Expected Delivery</p><p className="text-slate-700 mt-0.5">{fmtDate(po.latestSubmission.data.expectedDeliveryDate)}</p></div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Billing</p>
              <p className="text-sm text-slate-700">{po.latestSubmission.data.billingCompany}</p>
              <p className="text-sm text-slate-600">{po.latestSubmission.data.billingAddress}</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {[po.latestSubmission.data.billingCity, po.latestSubmission.data.billingState, po.latestSubmission.data.billingPin].filter(Boolean).join(', ')}
              </p>
              {po.latestSubmission.data.billingGstin && <p className="text-xs text-slate-400">GSTIN: {po.latestSubmission.data.billingGstin}</p>}
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Shipping</p>
              <p className="text-sm text-slate-700">{po.latestSubmission.data.shippingCompany}</p>
              <p className="text-sm text-slate-600">{po.latestSubmission.data.shippingAddress}</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {[po.latestSubmission.data.shippingCity, po.latestSubmission.data.shippingState, po.latestSubmission.data.shippingPin].filter(Boolean).join(', ')}
              </p>
              {po.latestSubmission.data.shippingGstin && <p className="text-xs text-slate-400">GSTIN: {po.latestSubmission.data.shippingGstin}</p>}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3 text-right">Qty</th>
                  <th className="py-2 pr-3 text-right">Unit Price</th>
                  <th className="py-2 text-right">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {po.latestSubmission.data.lineItems.map((l, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 text-slate-700">{l.code ? `[${l.code}] ` : ''}{l.description ?? '—'}</td>
                    <td className="py-2 pr-3 text-right text-slate-600">{l.quantity ?? '—'}</td>
                    <td className="py-2 pr-3 text-right text-slate-600">{fmtInr(l.unitPrice)}</td>
                    <td className="py-2 text-right text-slate-700">{fmtInr(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-6 text-sm border-t border-slate-100 pt-3">
            <p className="text-slate-500">Untaxed: <span className="text-slate-800 font-medium">{fmtInr(po.latestSubmission.data.untaxedAmount)}</span></p>
            <p className="text-slate-500">Tax: <span className="text-slate-800 font-medium">{fmtInr(po.latestSubmission.data.taxAmount)}</span></p>
            <p className="text-slate-500">Total: <span className="text-slate-900 font-semibold">{fmtInr(po.latestSubmission.data.grandTotal)}</span></p>
          </div>

          {po.latestSubmission.comparisonWarnings.length > 0 && (
            <div className="space-y-1.5 border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold text-slate-500 uppercase">PI Comparison</p>
              {po.latestSubmission.comparisonWarnings.map((w, i) => <WarningRow key={i} w={w} />)}
            </div>
          )}

          {po.status === 'submitted' && (
            <div className="pt-2 space-y-3 border-t border-slate-100">
              {!po.salespersonAssigned && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  No salesperson is assigned — a correction request would be recorded but no follow-up activity could be scheduled.
                </p>
              )}
              {actionError && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{actionError}</p>}
              {actionWarning && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{actionWarning}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleApprove} disabled={busy}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {busy ? 'Working...' : 'Approve PO'}
                </button>
                {!showCorrectionForm && (
                  <button
                    onClick={() => setShowCorrectionForm(true)}
                    disabled={busy}
                    className="text-sm text-amber-700 hover:text-amber-800 border border-amber-200 hover:border-amber-300 bg-amber-50 px-4 py-2 rounded-lg transition-all"
                  >
                    Request Correction
                  </button>
                )}
              </div>
              {showCorrectionForm && (
                <div className="space-y-3">
                  <textarea
                    rows={3} maxLength={2000} value={correctionComment} onChange={e => setCorrectionComment(e.target.value)}
                    placeholder="Describe what needs correcting in the PO..."
                    className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleRequestCorrection} disabled={busy}
                      className="bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                    >
                      {busy ? 'Submitting...' : 'Submit Correction Request'}
                    </button>
                    <button onClick={() => { setShowCorrectionForm(false); setCorrectionComment(''); }} className="text-sm text-slate-500 hover:text-slate-700">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {po.status === 'correction_requested' && po.latestCorrection && (
            <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
              Correction requested by {po.latestCorrection.requestedBy} — awaiting a revised submission from the customer.
            </p>
          )}

          {po.status === 'approved' && po.latestApproval && (
            <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
              Approved by {po.latestApproval.approvedBy} on {fmtDate(po.latestApproval.approvedAt.slice(0, 10))}.
              {!po.latestApproval.poNumberSavedToOdoo && ' (Could not save PO number to Odoo — check server logs.)'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
