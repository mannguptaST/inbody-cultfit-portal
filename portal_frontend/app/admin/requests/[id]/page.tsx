'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  getAdminRequestDetail, getEligibleSalespeople, assignRequestSalesperson,
  createDraftPI, createPIRevision, updatePIDraft, publishPI,
  getTerritories, updateRequestTerritory, searchAdminProducts, addPILine, updatePILine, removePILine,
  getLogisticsDispatch,
} from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { PI_STATUS_LABELS, PI_STATUS_VARIANT, PO_STATUS_LABELS, PO_STATUS_VARIANT, STAGE_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import AdminPoSection from '@/components/AdminPoSection';
import DeliveryTrackingSection from '@/components/DeliveryTrackingSection';
import type { AdminRequestDetail, EligibleSalesperson, TerritoryOption, AdminProductOption, DispatchInfo } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtInr(n: number | null | undefined): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function AdminRequestDetailPage() {
  const router = useRouter();
  const params = useParams();
  const requestId = Number(params.id);

  const [userName, setUserName] = useState('');
  const [request, setRequest] = useState<AdminRequestDetail | null>(null);
  const [dispatch, setDispatch] = useState<DispatchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [salespeople, setSalespeople] = useState<EligibleSalesperson[]>([]);
  const [selectedSalesperson, setSelectedSalesperson] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [actionError, setActionError] = useState('');

  const [validityInput, setValidityInput] = useState('');
  const [busy, setBusy] = useState(false);

  const [territories, setTerritories] = useState<TerritoryOption[]>([]);
  const [selectedTerritory, setSelectedTerritory] = useState('');
  const [territoryBusy, setTerritoryBusy] = useState(false);

  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState<AdminProductOption[]>([]);
  const [productSearching, setProductSearching] = useState(false);
  const [newLineProduct, setNewLineProduct] = useState<AdminProductOption | null>(null);
  const [newLineQty, setNewLineQty] = useState('1');
  const [newLineDiscCalc, setNewLineDiscCalc] = useState<'percentage' | 'fixed'>('percentage');
  const [newLineDiscount, setNewLineDiscount] = useState('0');
  const [newLineFixedAmount, setNewLineFixedAmount] = useState('0');
  type LineEdit = { quantity: string; discCalculation: 'percentage' | 'fixed'; discount: string; fixedAmount: string };
  const [lineEdits, setLineEdits] = useState<Record<number, LineEdit>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getAdminRequestDetail(requestId);
      setRequest(detail);
      setValidityInput(detail.draftPI?.validityDate || '');
      setSelectedTerritory(detail.currentTerritory ? String(detail.currentTerritory.id) : '');
      const edits: Record<number, LineEdit> = {};
      detail.draftPI?.lines.forEach(l => {
        edits[l.id] = {
          quantity: String(l.quantity), discCalculation: l.discCalculation,
          discount: String(l.discount), fixedAmount: String(l.fixedAmount),
        };
      });
      setLineEdits(edits);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load request.');
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  const loadDispatch = useCallback(() => {
    if (!requestId) return;
    getLogisticsDispatch(requestId).then(setDispatch).catch(() => setDispatch(null));
  }, [requestId]);

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (!isInBodyStaff(u.role)) { router.replace('/dashboard'); return; }
      setUserName(u.name ?? '');
    });
    if (!requestId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
    load();
    loadDispatch();
    getEligibleSalespeople().then(res => setSalespeople(res.salespeople)).catch(() => {});
    getTerritories().then(res => setTerritories(res.territories)).catch(() => {});
  }, [requestId, router, load, loadDispatch]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function handleAssignSalesperson() {
    if (!selectedSalesperson) return;
    setAssigning(true);
    setActionError('');
    try {
      await assignRequestSalesperson(requestId, Number(selectedSalesperson));
      await load();
      setSelectedSalesperson('');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to assign salesperson.');
    } finally {
      setAssigning(false);
    }
  }

  async function handleCreateDraft(isRevision: boolean) {
    setBusy(true);
    setActionError('');
    try {
      if (isRevision) await createPIRevision(requestId);
      else await createDraftPI(requestId);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to create PI.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft() {
    if (!request?.draftPI) return;
    setBusy(true);
    setActionError('');
    try {
      await updatePIDraft(requestId, request.draftPI.id, { validityDate: validityInput || undefined });
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to save draft.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (!request?.draftPI) return;
    if (!confirm('Publish this PI? The customer will be able to view and download it immediately.')) return;
    setBusy(true);
    setActionError('');
    try {
      await publishPI(requestId, request.draftPI.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to publish PI.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateTerritory() {
    if (!selectedTerritory) return;
    setTerritoryBusy(true);
    setActionError('');
    try {
      await updateRequestTerritory(requestId, Number(selectedTerritory));
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update Territory.');
    } finally {
      setTerritoryBusy(false);
    }
  }

  async function handleProductSearch(q: string) {
    setProductQuery(q);
    setNewLineProduct(null);
    if (!q.trim()) { setProductResults([]); return; }
    setProductSearching(true);
    try {
      const res = await searchAdminProducts(q);
      setProductResults(res.products);
    } catch {
      setProductResults([]);
    } finally {
      setProductSearching(false);
    }
  }

  async function handleAddLine() {
    if (!request?.draftPI || !newLineProduct) return;
    const qty = Number(newLineQty);
    if (!Number.isInteger(qty) || qty < 1) { setActionError('Enter a valid quantity.'); return; }
    if (newLineDiscCalc === 'percentage') {
      const discount = Number(newLineDiscount);
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) { setActionError('Discount must be between 0 and 100.'); return; }
    } else {
      const fixedAmount = Number(newLineFixedAmount);
      const maxAmount = newLineProduct.unitPrice * qty;
      if (!Number.isFinite(fixedAmount) || fixedAmount < 0 || fixedAmount > maxAmount) {
        setActionError(`Fixed discount amount must be between 0 and ${fmtInr(maxAmount)}.`);
        return;
      }
    }
    const alreadyOnPI = request.draftPI.lines.some(l => l.productId === newLineProduct.id);
    if (alreadyOnPI && !confirm(`[${newLineProduct.code}] ${newLineProduct.name} is already a line on this PI. Add it again anyway?`)) return;

    setBusy(true);
    setActionError('');
    try {
      await addPILine(requestId, request.draftPI.id, newLineProduct.id, qty, {
        discCalculation: newLineDiscCalc,
        discount: newLineDiscCalc === 'percentage' ? Number(newLineDiscount) : undefined,
        fixedAmount: newLineDiscCalc === 'fixed' ? Number(newLineFixedAmount) : undefined,
      });
      setNewLineProduct(null);
      setProductQuery('');
      setProductResults([]);
      setNewLineQty('1');
      setNewLineDiscCalc('percentage');
      setNewLineDiscount('0');
      setNewLineFixedAmount('0');
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to add product line.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveLine(lineId: number) {
    if (!request?.draftPI) return;
    const edit = lineEdits[lineId];
    if (!edit) return;
    setBusy(true);
    setActionError('');
    try {
      await updatePILine(requestId, request.draftPI.id, lineId, {
        quantity: Number(edit.quantity),
        discCalculation: edit.discCalculation,
        discount: edit.discCalculation === 'percentage' ? Number(edit.discount) : undefined,
        fixedAmount: edit.discCalculation === 'fixed' ? Number(edit.fixedAmount) : undefined,
      });
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update line.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveLine(lineId: number) {
    if (!request?.draftPI) return;
    if (!confirm('Remove this product line from the PI?')) return;
    setBusy(true);
    setActionError('');
    try {
      await removePILine(requestId, request.draftPI.id, lineId);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove line.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="STAFF" userName={userName} backHref="/admin/requests" backLabel="Requests" />
      <div className="flex items-center justify-center py-32">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
      </div>
    </div>
  );

  if (error || !request) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="STAFF" userName={userName} backHref="/admin/requests" backLabel="Requests" />
      <div className="flex items-center justify-center py-32 px-4">
        <div className="bg-white border border-red-200 rounded-xl p-8 text-center max-w-sm">
          <p className="text-red-700 font-medium mb-4">{error || 'Request not found.'}</p>
          <button onClick={() => router.back()} className="text-blue-600 text-sm hover:underline">Go back</button>
        </div>
      </div>
    </div>
  );

  const d = request.details;
  const hasSalesperson = !!request.salesperson;
  const canCreateDraft = hasSalesperson && !request.draftPI;
  const canRevise = !!request.draftPI;
  const canPublish = !!request.draftPI && request.draftPI.state !== 'cancel' && request.piStatus !== 'awaiting_confirmation'
    && request.piStatus !== 'confirmed' && request.piStatus !== 'correction_requested';

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="STAFF" userName={userName} backHref="/admin/requests" backLabel="Requests" crumb={`REQ-${request.id}`} onLogout={handleLogout} />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 font-mono">REQ-{request.id}</h1>
                <StatusChip label={request.portal_stage_label} variant={STAGE_VARIANT[request.portal_stage] ?? 'neutral'} />
                <StatusChip label={PI_STATUS_LABELS[request.piStatus]} variant={PI_STATUS_VARIANT[request.piStatus]} />
                <StatusChip label={PO_STATUS_LABELS[request.po.status]} variant={PO_STATUS_VARIANT[request.po.status]} />
              </div>
              <p className="text-slate-700 font-medium mt-2">{request.name}</p>
              {d && <p className="text-slate-500 text-sm mt-0.5">{d.deliveryAddress}</p>}
            </div>
            <div className="text-right flex-shrink-0 text-xs text-slate-400">
              <p>Created {fmtDate(request.created_date)}</p>
              <p className="mt-0.5">Last updated {fmtDate(request.last_updated)}</p>
            </div>
          </div>
        </div>

        {actionError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm text-red-700">{actionError}</div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

          <div className="lg:col-span-2 space-y-6">

            {/* Request details */}
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
                  {d.contact && (d.contact.name || d.contact.phone || d.contact.email) && (
                    <div>
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Contact (from Odoo)</p>
                      <p className="text-sm text-slate-700 mt-0.5">
                        {[d.contact.name, d.contact.phone, d.contact.email].filter(Boolean).join(' · ')}
                      </p>
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

            {/* PI creation / editor / publish */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Proforma Invoice</h2>

              {!hasSalesperson && (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                  Assign a salesperson before creating a PI.
                </p>
              )}

              {canCreateDraft && (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">
                    {d?.mainProduct.name} — unit price will be set automatically from this product&apos;s Sales Price in Odoo.
                  </p>
                  <button
                    onClick={() => handleCreateDraft(false)}
                    disabled={busy}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    Create Draft PI
                  </button>
                </div>
              )}

              {request.draftPI && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-sm font-semibold text-slate-800 font-mono">{request.draftPI.name}</p>
                    <StatusChip label={PI_STATUS_LABELS[request.piStatus]} variant={PI_STATUS_VARIANT[request.piStatus]} />
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                          <th className="py-2 pr-3">Product</th>
                          <th className="py-2 pr-3 text-right">Quantity</th>
                          <th className="py-2 pr-3 text-right">Unit</th>
                          <th className="py-2 pr-3 text-right">Unit Price</th>
                          <th className="py-2 pr-3 text-right">Taxes</th>
                          <th className="py-2 pr-3 text-right">Disc. Calculation</th>
                          <th className="py-2 pr-3 text-right">Fixed Amount</th>
                          <th className="py-2 pr-3 text-right">Disc. %</th>
                          <th className="py-2 pr-3 text-right">Amount</th>
                          {canPublish && <th className="py-2"></th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {request.draftPI.lines.map(l => {
                          const edit = lineEdits[l.id];
                          const calc = edit?.discCalculation ?? l.discCalculation;
                          const patchEdit = (patch: Partial<LineEdit>) => {
                            setLineEdits(prev => ({
                              ...prev,
                              [l.id]: {
                                quantity: prev[l.id]?.quantity ?? String(l.quantity),
                                discCalculation: prev[l.id]?.discCalculation ?? l.discCalculation,
                                discount: prev[l.id]?.discount ?? String(l.discount),
                                fixedAmount: prev[l.id]?.fixedAmount ?? String(l.fixedAmount),
                                ...patch,
                              },
                            }));
                          };
                          return (
                            <tr key={l.id}>
                              <td className="py-2 pr-3 text-slate-700">[{l.code}] {l.name}</td>
                              {canPublish ? (
                                <>
                                  <td className="py-2 pr-3 text-right">
                                    <input
                                      type="number" min={1} value={edit?.quantity ?? String(l.quantity)}
                                      onChange={e => patchEdit({ quantity: e.target.value })}
                                      className="w-16 text-right text-sm border border-slate-200 rounded px-2 py-1"
                                    />
                                  </td>
                                  <td className="py-2 pr-3 text-right text-slate-500 text-xs">{l.unit || '—'}</td>
                                  <td className="py-2 pr-3 text-right text-slate-600">{fmtInr(l.unitPrice)}</td>
                                  <td className="py-2 pr-3 text-right text-slate-500 text-xs">{l.taxLabel}</td>
                                  <td className="py-2 pr-3 text-right">
                                    <select
                                      value={calc}
                                      onChange={e => patchEdit({ discCalculation: e.target.value as 'percentage' | 'fixed' })}
                                      className="text-sm border border-slate-200 rounded px-2 py-1 bg-white"
                                    >
                                      <option value="percentage">Percentage</option>
                                      <option value="fixed">Fixed</option>
                                    </select>
                                  </td>
                                  <td className="py-2 pr-3 text-right">
                                    <input
                                      type="number" min={0} disabled={calc !== 'fixed'}
                                      value={calc === 'fixed' ? (edit?.fixedAmount ?? String(l.fixedAmount)) : ''}
                                      placeholder={calc !== 'fixed' ? '—' : undefined}
                                      onChange={e => patchEdit({ fixedAmount: e.target.value })}
                                      className="w-24 text-right text-sm border border-slate-200 rounded px-2 py-1 disabled:bg-slate-50 disabled:text-slate-300"
                                    />
                                  </td>
                                  <td className="py-2 pr-3 text-right">
                                    <input
                                      type="number" min={0} max={100} disabled={calc !== 'percentage'}
                                      value={calc === 'percentage' ? (edit?.discount ?? String(l.discount)) : ''}
                                      placeholder={calc !== 'percentage' ? '—' : undefined}
                                      onChange={e => patchEdit({ discount: e.target.value })}
                                      className="w-16 text-right text-sm border border-slate-200 rounded px-2 py-1 disabled:bg-slate-50 disabled:text-slate-300"
                                    />
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td className="py-2 pr-3 text-right text-slate-600">{l.quantity}</td>
                                  <td className="py-2 pr-3 text-right text-slate-500 text-xs">{l.unit || '—'}</td>
                                  <td className="py-2 pr-3 text-right text-slate-600">{fmtInr(l.unitPrice)}</td>
                                  <td className="py-2 pr-3 text-right text-slate-500 text-xs">{l.taxLabel}</td>
                                  <td className="py-2 pr-3 text-right text-slate-600 text-xs capitalize">{l.discCalculation}</td>
                                  <td className="py-2 pr-3 text-right text-slate-600">{l.discCalculation === 'fixed' ? fmtInr(l.fixedAmount) : '—'}</td>
                                  <td className="py-2 pr-3 text-right text-slate-600">{l.discCalculation === 'percentage' ? `${l.discount}%` : '—'}</td>
                                </>
                              )}
                              <td className="py-2 pr-3 text-right text-slate-700 font-medium">{fmtInr(l.lineTotal)}</td>
                              {canPublish && (
                                <td className="py-2 text-right whitespace-nowrap">
                                  <button onClick={() => handleSaveLine(l.id)} disabled={busy} className="text-xs text-blue-600 hover:underline mr-2 disabled:opacity-50">Save</button>
                                  <button onClick={() => handleRemoveLine(l.id)} disabled={busy} className="text-xs text-red-600 hover:underline disabled:opacity-50">Remove</button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {canPublish && (
                    <div className="border border-dashed border-slate-200 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-medium text-slate-600">Add a product</p>
                      <p className="text-xs text-slate-400">
                        Search the full Odoo sales catalog by product name, internal reference, or code — not limited to any predefined bundle.
                      </p>
                      <div className="flex flex-wrap gap-2 items-start">
                        <div className="relative flex-1 min-w-[260px]">
                          <input
                            type="text" value={productQuery} onChange={e => handleProductSearch(e.target.value)}
                            placeholder="Search by product name, internal reference, or code..."
                            className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          {productResults.length > 0 && (
                            <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                              {productResults.map(p => (
                                <button
                                  key={p.id} type="button"
                                  onClick={() => { setNewLineProduct(p); setProductQuery(`[${p.code}] ${p.name}`); setProductResults([]); }}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-50 last:border-0 flex flex-wrap justify-between gap-x-3 gap-y-0.5"
                                >
                                  <span className="text-slate-700">[{p.code}] {p.name}</span>
                                  <span className="text-slate-400 text-xs whitespace-nowrap">
                                    {fmtInr(p.unitPrice)} · {p.unit || '—'} · {p.taxLabel}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                          {productSearching && <p className="text-xs text-slate-400 mt-1">Searching...</p>}
                          {newLineProduct && (
                            <p className="text-xs text-slate-500 mt-1">
                              From Odoo (locked): <span className="font-medium text-slate-700">{fmtInr(newLineProduct.unitPrice)}</span>
                              {' · '}{newLineProduct.unit || '—'}{' · '}{newLineProduct.taxLabel}
                            </p>
                          )}
                        </div>
                        <input
                          type="number" min={1} value={newLineQty} onChange={e => setNewLineQty(e.target.value)}
                          placeholder="Qty" className="w-20 text-sm border border-slate-300 rounded-lg px-3 py-2"
                        />
                        <select
                          value={newLineDiscCalc}
                          onChange={e => setNewLineDiscCalc(e.target.value as 'percentage' | 'fixed')}
                          className="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white"
                        >
                          <option value="percentage">Percentage</option>
                          <option value="fixed">Fixed</option>
                        </select>
                        {newLineDiscCalc === 'fixed' ? (
                          <input
                            type="number" min={0} value={newLineFixedAmount} onChange={e => setNewLineFixedAmount(e.target.value)}
                            placeholder="Fixed Amount (₹)" className="w-32 text-sm border border-slate-300 rounded-lg px-3 py-2"
                          />
                        ) : (
                          <input
                            type="number" min={0} max={100} value={newLineDiscount} onChange={e => setNewLineDiscount(e.target.value)}
                            placeholder="Disc. %" className="w-24 text-sm border border-slate-300 rounded-lg px-3 py-2"
                          />
                        )}
                        <button
                          onClick={handleAddLine} disabled={busy || !newLineProduct}
                          className="bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-6 text-sm border-t border-slate-100 pt-3">
                    <p className="text-slate-500">Untaxed: <span className="text-slate-800 font-medium">{fmtInr(request.draftPI.untaxedAmount)}</span></p>
                    <p className="text-slate-500">Tax: <span className="text-slate-800 font-medium">{fmtInr(request.draftPI.taxAmount)}</span></p>
                    <p className="text-slate-500">Total: <span className="text-slate-900 font-semibold">{fmtInr(request.draftPI.totalAmount)}</span></p>
                  </div>

                  {canPublish ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">Validity Date</label>
                        <input
                          type="date" value={validityInput} onChange={e => setValidityInput(e.target.value)}
                          className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Published — validity {fmtDate(request.draftPI.validityDate)}. Use &quot;Create Revision&quot; to change price or terms.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    {canPublish && (
                      <>
                        <button
                          onClick={handleSaveDraft} disabled={busy}
                          className="text-sm text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white px-4 py-2 rounded-lg transition-all disabled:opacity-50"
                        >
                          Save Draft
                        </button>
                        <button
                          onClick={handlePublish} disabled={busy}
                          className="bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                        >
                          Publish PI
                        </button>
                      </>
                    )}
                    {canRevise && (
                      <button
                        onClick={() => handleCreateDraft(true)} disabled={busy}
                        className="text-sm text-amber-700 hover:text-amber-800 border border-amber-200 hover:border-amber-300 bg-amber-50 px-4 py-2 rounded-lg transition-all disabled:opacity-50 ml-auto"
                      >
                        Create Revision
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* PO review (Phase 3) */}
            <AdminPoSection requestId={request.id} po={request.po} onChange={load} />

            {/* Delivery Tracking (Phase 4, shared with /logistics) */}
            {dispatch && (
              <DeliveryTrackingSection orderId={request.id} dispatch={dispatch} editable onSaved={loadDispatch} />
            )}

            {request.timeline.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">History</h2>
                <div className="space-y-4">
                  {request.timeline.map((entry, i) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-slate-700">{entry.body}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{entry.author} · {fmtDate(entry.date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: salesperson assignment */}
          <div className="space-y-5 lg:sticky lg:top-20">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Salesperson</h2>
              <p className="text-sm text-slate-700 mb-3">
                {request.salesperson ?? <span className="text-slate-400">Not yet assigned</span>}
              </p>
              <select
                value={selectedSalesperson}
                onChange={e => setSelectedSalesperson(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
              >
                <option value="">Select salesperson...</option>
                {salespeople.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button
                onClick={handleAssignSalesperson}
                disabled={!selectedSalesperson || assigning}
                className="w-full bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {assigning ? 'Assigning...' : request.salesperson ? 'Reassign' : 'Assign'}
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Region</h2>
              {request.currentTerritory ? (
                <p className="text-sm text-slate-700 mb-3">{request.currentTerritory.name}</p>
              ) : (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                  Region requires Admin review.
                </p>
              )}
              {d?.regionDetection && (
                <p className="text-xs text-slate-400 mb-3">
                  Auto-detected from &quot;{d.regionDetection.matchedToken ?? '—'}&quot;
                  {d.regionDetection.confidence === 'unclear' ? ' — unclear, not auto-assigned.' : '.'}
                </p>
              )}
              <select
                value={selectedTerritory}
                onChange={e => setSelectedTerritory(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
              >
                <option value="">Select Territory...</option>
                {territories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button
                onClick={handleUpdateTerritory}
                disabled={!selectedTerritory || territoryBusy}
                className="w-full bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {territoryBusy ? 'Saving...' : 'Save Territory'}
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Opportunity Defaults</h2>
              <dl className="space-y-2 text-sm">
                {([
                  ['Key Account Manager', request.opportunityDefaults.keyAccountManager],
                  ['Industry', request.opportunityDefaults.industry],
                  ['Sub Industry', request.opportunityDefaults.subIndustry],
                  ['Source', request.opportunityDefaults.source],
                  ['Sub Lead Source', request.opportunityDefaults.subLeadSource],
                  ['Ownership', request.opportunityDefaults.ownership],
                  ['Channel', request.opportunityDefaults.channel],
                  ['Account Type', request.opportunityDefaults.accountType],
                ] as [string, string | null][]).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-slate-400">{label}</dt>
                    <dd className="text-slate-700 font-medium text-right">{value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
