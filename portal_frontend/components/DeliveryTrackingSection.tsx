'use client';

import { useState } from 'react';
import { updateLogisticsDispatch } from '@/lib/api';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT } from '@/lib/stage-config';
import StatusChip from '@/components/StatusChip';
import type { DispatchInfo, DeliveryStatus } from '@/types';

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSafeTrackingUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const DELIVERY_STATUS_OPTIONS: DeliveryStatus[] = [
  'not_started', 'logistics_processing', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'delivery_issue',
];

const inputCls = 'w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'text-xs font-medium text-slate-600 block mb-1';

// Shared Delivery Tracking panel — editable (Admin/Logistics, writes via the
// existing role-gated dispatch route) or read-only (Customer/CS). Both modes
// read the exact same DispatchInfo shape so there is only ever one source of
// truth rendered two ways, never a second parallel display of the same data.
export default function DeliveryTrackingSection({
  orderId, dispatch, editable, onSaved,
}: {
  orderId: number;
  dispatch: DispatchInfo;
  editable: boolean;
  onSaved?: () => void;
}) {
  const [form, setForm] = useState({
    dispatchDate: dispatch.dispatchDate ?? '',
    courier: dispatch.courier ?? '',
    awb: dispatch.awb ?? '',
    trackingUrl: dispatch.trackingUrl ?? '',
    expectedDeliveryDate: dispatch.expectedDeliveryDate ?? '',
    actualDeliveryDate: dispatch.actualDeliveryDate ?? '',
    deliveryStatus: dispatch.deliveryStatus,
    logisticsNote: dispatch.logisticsNote ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await updateLogisticsDispatch(orderId, {
        dispatchDate: form.dispatchDate || null,
        courier: form.courier || null,
        awb: form.awb || null,
        trackingUrl: form.trackingUrl || null,
        expectedDeliveryDate: form.expectedDeliveryDate || null,
        actualDeliveryDate: form.actualDeliveryDate || null,
        deliveryStatus: form.deliveryStatus,
        logisticsNote: form.logisticsNote || null,
      });
      setSaved(true);
      onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save delivery tracking info.');
    } finally {
      setBusy(false);
    }
  }

  if (!editable) {
    const hasInfo = dispatch.deliveryStatus !== 'not_started' || dispatch.courier || dispatch.awb || dispatch.trackingUrl;
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Delivery Tracking</h2>
        {!hasInfo ? (
          <p className="text-sm text-slate-500">Tracking details are not available yet.</p>
        ) : (
          <div className="space-y-3">
            <StatusChip label={DELIVERY_STATUS_LABELS[dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[dispatch.deliveryStatus]} />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              {dispatch.courier && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Courier</p><p className="text-slate-700 mt-0.5">{dispatch.courier}</p></div>}
              {dispatch.awb && <div><p className="text-xs text-slate-400 uppercase tracking-wide">AWB / Tracking No.</p><p className="text-slate-700 mt-0.5 font-mono">{dispatch.awb}</p></div>}
              {dispatch.dispatchDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Dispatch Date</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.dispatchDate)}</p></div>}
              {dispatch.expectedDeliveryDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Expected Delivery</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.expectedDeliveryDate)}</p></div>}
              {dispatch.actualDeliveryDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Actual Delivery</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.actualDeliveryDate)}</p></div>}
            </div>
            {isSafeTrackingUrl(dispatch.trackingUrl) && (
              <a
                href={dispatch.trackingUrl!} target="_blank" rel="noopener noreferrer"
                className="inline-block text-sm text-blue-600 hover:text-blue-700 border border-blue-200 hover:border-blue-300 bg-blue-50 px-4 py-2 rounded-lg transition-all"
              >
                Track Shipment
              </a>
            )}
            {dispatch.logisticsNote && (
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wide">Delivery Notes</p>
                <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{dispatch.logisticsNote}</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Delivery Tracking</h2>
        {dispatch.pickingId && (
          <span className="text-xs text-slate-400">Linked picking: <span className="font-mono">{dispatch.pickingName}</span> ({dispatch.pickingState})</span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Delivery Status</label>
          <select className={inputCls + ' bg-white'} value={form.deliveryStatus} onChange={e => setForm(f => ({ ...f, deliveryStatus: e.target.value as DeliveryStatus }))}>
            {DELIVERY_STATUS_OPTIONS.map(s => <option key={s} value={s}>{DELIVERY_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
        <div><label className={labelCls}>Courier / Transporter</label><input type="text" maxLength={120} className={inputCls} value={form.courier} onChange={e => setForm(f => ({ ...f, courier: e.target.value }))} /></div>
        <div><label className={labelCls}>Tracking ID / AWB Number</label><input type="text" maxLength={60} className={inputCls} value={form.awb} onChange={e => setForm(f => ({ ...f, awb: e.target.value }))} /></div>
        <div><label className={labelCls}>Tracking URL</label><input type="url" placeholder="https://..." className={inputCls} value={form.trackingUrl} onChange={e => setForm(f => ({ ...f, trackingUrl: e.target.value }))} /></div>
        <div><label className={labelCls}>Dispatch Date</label><input type="date" className={inputCls} value={form.dispatchDate} onChange={e => setForm(f => ({ ...f, dispatchDate: e.target.value }))} /></div>
        <div><label className={labelCls}>Expected Delivery Date</label><input type="date" className={inputCls} value={form.expectedDeliveryDate} onChange={e => setForm(f => ({ ...f, expectedDeliveryDate: e.target.value }))} /></div>
        <div><label className={labelCls}>Actual Delivery Date</label><input type="date" className={inputCls} value={form.actualDeliveryDate} onChange={e => setForm(f => ({ ...f, actualDeliveryDate: e.target.value }))} /></div>
      </div>
      <div className="mt-4">
        <label className={labelCls}>Delivery Notes</label>
        <textarea rows={3} maxLength={1000} className={inputCls + ' resize-none'} value={form.logisticsNote} onChange={e => setForm(f => ({ ...f, logisticsNote: e.target.value }))} />
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button onClick={handleSave} disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
          {busy ? 'Saving...' : 'Save Delivery Update'}
        </button>
        {saved && <span className="text-sm text-green-700">Saved.</span>}
      </div>
      {error && <p className="text-sm text-red-700 mt-2">{error}</p>}
      {!dispatch.pickingId && (
        <p className="text-xs text-slate-400 mt-3">No linked Odoo delivery yet — these details are stored as portal logistics data and will be preferred alongside native fields once a delivery exists.</p>
      )}
    </div>
  );
}
