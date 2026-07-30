'use client';

import { useEffect, useState } from 'react';
import { getCustomerPoStatus, extractPoPdf, submitPoData } from '@/lib/api';
import type { PoCustomerView, PortalPoData, PortalPoLineItem, ExtractedPoData, ComparisonResult } from '@/types';

function fmtInr(n: number | null): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const PO_STATUS_LABEL: Record<string, string> = {
  awaiting_upload: 'Awaiting PO Upload',
  submitted: 'Submitted for InBody Review',
  correction_requested: 'Correction Requested',
  approved: 'PO Approved',
};

// Extraction returns nullable fields (never invented) — the review form
// needs editable string/number inputs, so empty values become '' here.
// Nothing here silently fills in a value the parser didn't find; the
// customer must type it themselves, and required fields are re-validated
// server-side on submit regardless of what's typed.
function extractedToDraft(e: ExtractedPoData): PortalPoData {
  return {
    poNumber: e.poNumber ?? '', poDate: e.poDate ?? '', expectedDeliveryDate: e.expectedDeliveryDate,
    paymentTerms: e.paymentTerms, currency: e.currency, requesterName: e.requesterName,
    createdBy: e.createdBy, approvedBy: e.approvedBy,
    billingCompany: e.billingCompany, billingAddress: e.billingAddress ?? '', billingCity: e.billingCity,
    billingState: e.billingState, billingPin: e.billingPin, billingGstin: e.billingGstin,
    shippingCompany: e.shippingCompany, shippingAddress: e.shippingAddress ?? '', shippingCity: e.shippingCity,
    shippingState: e.shippingState, shippingPin: e.shippingPin, shippingGstin: e.shippingGstin,
    lineItems: e.lineItems.length ? e.lineItems : [emptyLine()],
    untaxedAmount: e.untaxedAmount, taxAmount: e.taxAmount, grandTotal: e.grandTotal ?? 0,
    amountInWords: e.amountInWords, piReference: e.piReference, vendorName: e.vendorName,
    deliveryContact: e.deliveryContact, notesToSupplier: e.notesToSupplier,
  };
}

function emptyLine(): PortalPoLineItem {
  return { description: '', code: '', quantity: null, unit: '', unitPrice: null, baseValue: null, taxRate: null, taxAmount: null, lineTotal: null };
}

const inputCls = 'w-full text-sm border border-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'text-xs font-medium text-slate-600 block mb-1';

function WarningBadge({ severity }: { severity: ComparisonResult['severity'] }) {
  if (severity === 'match') {
    return <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">Match</span>;
  }
  return <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">Warning</span>;
}

export default function PoSection({ requestId }: { requestId: number }) {
  const [po, setPo] = useState<PoCustomerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  const [draft, setDraft] = useState<PortalPoData | null>(null);
  const [warnings, setWarnings] = useState<ComparisonResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  function load() {
    setLoading(true);
    getCustomerPoStatus(requestId)
      .then(setPo)
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load PO status.'))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
  useEffect(load, [requestId]);

  async function handleExtract() {
    if (!file) return;
    setExtracting(true);
    setExtractError('');
    try {
      const { extracted } = await extractPoPdf(requestId, file);
      setDraft(extractedToDraft(extracted));
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'Could not extract PO details.');
    } finally {
      setExtracting(false);
    }
  }

  function updateDraft<K extends keyof PortalPoData>(key: K, value: PortalPoData[K]) {
    setDraft(d => (d ? { ...d, [key]: value } : d));
  }

  function updateLine(i: number, key: keyof PortalPoLineItem, value: string) {
    setDraft(d => {
      if (!d) return d;
      const lines = [...d.lineItems];
      const numeric = ['quantity', 'unitPrice', 'baseValue', 'taxRate', 'taxAmount', 'lineTotal'].includes(key);
      lines[i] = { ...lines[i], [key]: numeric ? (value === '' ? null : Number(value)) : value };
      return { ...d, lineItems: lines };
    });
  }

  async function handleSubmit() {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await submitPoData(requestId, draft);
      setWarnings(result.comparisonWarnings);
      setDraft(null);
      setFile(null);
      load();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit PO data.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Purchase Order</h2>
        {po && po.status !== 'awaiting_upload' && (
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
            {PO_STATUS_LABEL[po.status]}
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-slate-400">Loading...</p>}
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {po && !loading && (
        <>
          {!po.piConfirmed ? (
            <p className="text-sm text-slate-500">PO upload will be available after PI confirmation.</p>
          ) : po.piSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4 pb-4 border-b border-slate-100">
              <div><p className="text-xs text-slate-400 uppercase tracking-wide">Confirmed PI</p><p className="font-mono text-slate-800 mt-0.5">{po.piSummary.quotationNumber} (v{po.piSummary.version})</p></div>
              <div><p className="text-xs text-slate-400 uppercase tracking-wide">Product</p><p className="text-slate-700 mt-0.5">{po.piSummary.mainProduct}</p></div>
              <div><p className="text-xs text-slate-400 uppercase tracking-wide">PI Total</p><p className="text-slate-700 mt-0.5">{fmtInr(po.piSummary.totalAmount)}</p></div>
              <div><p className="text-xs text-slate-400 uppercase tracking-wide">Delivery Address</p><p className="text-slate-700 mt-0.5 truncate">{po.piSummary.deliveryAddress}</p></div>
            </div>
          )}

          {po.piConfirmed && po.status === 'correction_requested' && po.latestCorrection && (
            <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <p className="font-medium">InBody requested a correction:</p>
              <p className="mt-0.5">{po.latestCorrection.comment}</p>
            </div>
          )}

          {/* Upload + extract — available when awaiting upload, or after a correction request */}
          {po.piConfirmed && !draft && (po.status === 'awaiting_upload' || po.status === 'correction_requested') && (
            <div className="space-y-3">
              <label className={labelCls}>Select PO PDF</label>
              <input
                type="file" accept="application/pdf"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-sm file:font-medium hover:file:bg-blue-100"
              />
              <p className="text-xs text-slate-400">PDF only, up to 4MB. The file is processed temporarily and never stored.</p>
              <button
                onClick={handleExtract}
                disabled={!file || extracting}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {extracting ? 'Extracting...' : 'Extract PO Details'}
              </button>
              {extractError && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{extractError}</p>}
            </div>
          )}

          {/* Review + correct + submit */}
          {draft && (
            <div className="space-y-5">
              <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                Review the extracted details below and correct anything the parser got wrong before submitting.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className={labelCls}>PO Number *</label><input className={inputCls} value={draft.poNumber} onChange={e => updateDraft('poNumber', e.target.value)} /></div>
                <div><label className={labelCls}>PO Date *</label><input type="date" className={inputCls} value={draft.poDate} onChange={e => updateDraft('poDate', e.target.value)} /></div>
                <div><label className={labelCls}>Expected Delivery Date</label><input type="date" className={inputCls} value={draft.expectedDeliveryDate ?? ''} onChange={e => updateDraft('expectedDeliveryDate', e.target.value || null)} /></div>
                <div><label className={labelCls}>Payment Terms</label><input className={inputCls} value={draft.paymentTerms ?? ''} onChange={e => updateDraft('paymentTerms', e.target.value || null)} /></div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Billing</p>
                  <input className={inputCls} placeholder="Company" value={draft.billingCompany ?? ''} onChange={e => updateDraft('billingCompany', e.target.value || null)} />
                  <textarea className={inputCls} rows={2} placeholder="Address *" value={draft.billingAddress} onChange={e => updateDraft('billingAddress', e.target.value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <input className={inputCls} placeholder="City" value={draft.billingCity ?? ''} onChange={e => updateDraft('billingCity', e.target.value || null)} />
                    <input className={inputCls} placeholder="State" value={draft.billingState ?? ''} onChange={e => updateDraft('billingState', e.target.value || null)} />
                    <input className={inputCls} placeholder="PIN" value={draft.billingPin ?? ''} onChange={e => updateDraft('billingPin', e.target.value || null)} />
                  </div>
                  <input className={inputCls} placeholder="GSTIN" value={draft.billingGstin ?? ''} onChange={e => updateDraft('billingGstin', e.target.value || null)} />
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Shipping</p>
                  <input className={inputCls} placeholder="Company/Location" value={draft.shippingCompany ?? ''} onChange={e => updateDraft('shippingCompany', e.target.value || null)} />
                  <textarea className={inputCls} rows={2} placeholder="Address *" value={draft.shippingAddress} onChange={e => updateDraft('shippingAddress', e.target.value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <input className={inputCls} placeholder="City" value={draft.shippingCity ?? ''} onChange={e => updateDraft('shippingCity', e.target.value || null)} />
                    <input className={inputCls} placeholder="State" value={draft.shippingState ?? ''} onChange={e => updateDraft('shippingState', e.target.value || null)} />
                    <input className={inputCls} placeholder="PIN" value={draft.shippingPin ?? ''} onChange={e => updateDraft('shippingPin', e.target.value || null)} />
                  </div>
                  <input className={inputCls} placeholder="GSTIN" value={draft.shippingGstin ?? ''} onChange={e => updateDraft('shippingGstin', e.target.value || null)} />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Product Lines *</p>
                <div className="space-y-2">
                  {draft.lineItems.map((l, i) => (
                    <div key={i} className="grid grid-cols-6 gap-2 items-center">
                      <input className={inputCls + ' col-span-2'} placeholder="Description" value={l.description ?? ''} onChange={e => updateLine(i, 'description', e.target.value)} />
                      <input className={inputCls} placeholder="Code" value={l.code ?? ''} onChange={e => updateLine(i, 'code', e.target.value)} />
                      <input className={inputCls} type="number" placeholder="Qty" value={l.quantity ?? ''} onChange={e => updateLine(i, 'quantity', e.target.value)} />
                      <input className={inputCls} type="number" placeholder="Unit Price" value={l.unitPrice ?? ''} onChange={e => updateLine(i, 'unitPrice', e.target.value)} />
                      <input className={inputCls} type="number" placeholder="Line Total" value={l.lineTotal ?? ''} onChange={e => updateLine(i, 'lineTotal', e.target.value)} />
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setDraft(d => (d ? { ...d, lineItems: [...d.lineItems, emptyLine()] } : d))}
                  className="text-xs text-blue-600 hover:underline mt-2"
                >
                  + Add line
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className={labelCls}>Untaxed Amount</label><input className={inputCls} type="number" value={draft.untaxedAmount ?? ''} onChange={e => updateDraft('untaxedAmount', e.target.value === '' ? null : Number(e.target.value))} /></div>
                <div><label className={labelCls}>Tax Amount</label><input className={inputCls} type="number" value={draft.taxAmount ?? ''} onChange={e => updateDraft('taxAmount', e.target.value === '' ? null : Number(e.target.value))} /></div>
                <div><label className={labelCls}>Grand Total *</label><input className={inputCls} type="number" value={draft.grandTotal} onChange={e => updateDraft('grandTotal', Number(e.target.value))} /></div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !draft.poNumber.trim() || !draft.poDate || !draft.billingAddress.trim() || !draft.shippingAddress.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {submitting ? 'Submitting...' : 'Submit for InBody Review'}
                </button>
                <button onClick={() => { setDraft(null); setFile(null); }} className="text-sm text-slate-500 hover:text-slate-700">
                  Cancel
                </button>
              </div>
              {submitError && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>}
            </div>
          )}

          {/* Submitted / correction_requested / approved — read-only summary */}
          {!draft && po.latestSubmission && (po.status === 'submitted' || po.status === 'correction_requested' || po.status === 'approved') && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">PO Number</p><p className="font-mono text-slate-800 mt-0.5">{po.latestSubmission.data.poNumber}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">PO Date</p><p className="text-slate-700 mt-0.5">{fmtDate(po.latestSubmission.data.poDate)}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Version</p><p className="text-slate-700 mt-0.5">V{po.latestSubmission.version}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Grand Total</p><p className="text-slate-700 mt-0.5">{fmtInr(po.latestSubmission.data.grandTotal)}</p></div>
              </div>

              {(warnings ?? po.latestSubmission.comparisonWarnings).filter(w => w.severity !== 'match').length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-slate-500 uppercase">PI Comparison Warnings</p>
                  {(warnings ?? po.latestSubmission.comparisonWarnings).filter(w => w.severity !== 'match').map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <WarningBadge severity={w.severity} />
                      <span className="text-slate-600">{w.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
