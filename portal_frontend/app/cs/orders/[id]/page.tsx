'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getCsOrderDetail, updateCsInstallation } from '@/lib/api';
import { fetchCurrentUser, logout } from '@/lib/auth';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT, INSTALLATION_STATUS_LABELS, INSTALLATION_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { CsOrderDetail, InstallationStatus, User } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

const INSTALLATION_STATUS_OPTIONS: InstallationStatus[] = [
  'not_scheduled', 'scheduled', 'in_progress', 'installed', 'completed',
];

const inputCls = 'w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'text-xs font-medium text-slate-600 block mb-1';

export default function CsOrderDetailPage() {
  const router = useRouter();
  const params = useParams();
  const orderId = Number(params.id);

  const [user, setUser] = useState<User | null>(null);
  const [order, setOrder] = useState<CsOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    status: 'not_scheduled' as InstallationStatus,
    scheduledDate: '', scheduledTime: '', installationNotes: '', completedOn: '', completionNotes: '',
  });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getCsOrderDetail(orderId);
      setOrder(detail);
      setForm({
        status: detail.installation.status,
        scheduledDate: detail.installation.scheduledDate ?? '',
        scheduledTime: detail.installation.scheduledTime ?? '',
        installationNotes: detail.installation.installationNotes ?? '',
        completedOn: detail.installation.completedOn ?? '',
        completionNotes: detail.installation.completionNotes ?? '',
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load order.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (u.role !== 'cs' && u.role !== 'admin') { router.replace('/dashboard'); return; }
      setUser(u);
    });
    if (!orderId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
    load();
  }, [orderId, router, load]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function handleSave() {
    setBusy(true);
    setSaveError('');
    setSaved(false);
    try {
      await updateCsInstallation(orderId, {
        status: form.status,
        scheduledDate: form.scheduledDate || null,
        scheduledTime: form.scheduledTime || null,
        installationNotes: form.installationNotes || null,
        completedOn: form.completedOn || null,
        completionNotes: form.completionNotes || null,
      });
      setSaved(true);
      await load();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save installation info.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CS" userName={user?.name} backHref="/cs" backLabel="CS" />
      <div className="flex items-center justify-center py-32">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
      </div>
    </div>
  );

  if (error || !order) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CS" userName={user?.name} backHref="/cs" backLabel="CS" />
      <div className="flex items-center justify-center py-32 px-4">
        <div className="bg-white border border-red-200 rounded-xl p-8 text-center max-w-sm">
          <p className="text-red-700 font-medium mb-4">{error || 'Order not found.'}</p>
          <button onClick={() => router.back()} className="text-blue-600 text-sm hover:underline">Go back</button>
        </div>
      </div>
    </div>
  );

  const d = order.requestDetails;

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CS" userName={user?.name} onLogout={handleLogout} backHref="/cs" backLabel="CS" crumb={`REQ-${order.id}`} />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 font-mono">REQ-{order.id}</h1>
                <StatusChip label={DELIVERY_STATUS_LABELS[order.dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[order.dispatch.deliveryStatus]} />
                <StatusChip label={INSTALLATION_STATUS_LABELS[order.installation.status]} variant={INSTALLATION_STATUS_VARIANT[order.installation.status]} />
              </div>
              <p className="text-slate-700 font-medium mt-2">{order.name}</p>
              <p className="text-slate-500 text-sm mt-0.5">{order.customer ?? '—'}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">

            {/* Read-only order info */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Order Details (Read-Only)</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Salesperson</p><p className="text-slate-700 mt-0.5">{order.salesperson ?? 'Not assigned'}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">CRM Stage</p><p className="text-slate-700 mt-0.5">{order.crmStage ?? '—'}</p></div>
                {d && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-400 uppercase tracking-wide">Product Bundle</p>
                    <p className="text-slate-700 mt-0.5">
                      {d.mainProduct.name} × {d.quantity}
                      {d.includedProducts.length > 0 && ` + ${d.includedProducts.map(p => p.name).join(', ')}`}
                    </p>
                  </div>
                )}
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Delivery Status</p><p className="text-slate-700 mt-0.5">{DELIVERY_STATUS_LABELS[order.dispatch.deliveryStatus]}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Actual Delivery Date</p><p className="text-slate-700 mt-0.5">{fmtDate(order.dispatch.actualDeliveryDate)}</p></div>
                {order.installation.installationRequired !== null && (
                  <div><p className="text-xs text-slate-400 uppercase tracking-wide">Odoo Installation Flag</p><p className="text-slate-700 mt-0.5">{order.installation.installationRequired ? 'Required' : 'Not required'}</p></div>
                )}
              </div>
            </div>

            {/* Installation panel */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Installation</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Installation Status</label>
                  <select className={inputCls + ' bg-white'} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as InstallationStatus }))}>
                    {INSTALLATION_STATUS_OPTIONS.map(s => <option key={s} value={s}>{INSTALLATION_STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
                <div />
                <div><label className={labelCls}>Installation Date</label><input type="date" className={inputCls} value={form.scheduledDate} onChange={e => setForm(f => ({ ...f, scheduledDate: e.target.value }))} /></div>
                <div><label className={labelCls}>Installation Time</label><input type="time" className={inputCls} value={form.scheduledTime} onChange={e => setForm(f => ({ ...f, scheduledTime: e.target.value }))} /></div>
                <div><label className={labelCls}>Completed On</label><input type="date" className={inputCls} value={form.completedOn} onChange={e => setForm(f => ({ ...f, completedOn: e.target.value }))} /></div>
              </div>
              <div className="mt-4">
                <label className={labelCls}>Installation Notes</label>
                <textarea rows={3} maxLength={1000} className={inputCls + ' resize-none'} value={form.installationNotes} onChange={e => setForm(f => ({ ...f, installationNotes: e.target.value }))} />
              </div>
              <div className="mt-4">
                <label className={labelCls}>Completion Notes</label>
                <textarea rows={3} maxLength={1000} className={inputCls + ' resize-none'} value={form.completionNotes} onChange={e => setForm(f => ({ ...f, completionNotes: e.target.value }))} />
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button onClick={handleSave} disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
                  {busy ? 'Saving...' : 'Save'}
                </button>
                {saved && <span className="text-sm text-green-700">Saved.</span>}
              </div>
              {saveError && <p className="text-sm text-red-700 mt-2">{saveError}</p>}
            </div>

            {order.timeline.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Timeline</h2>
                <div className="space-y-4">
                  {order.timeline.map((entry, i) => (
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

          <div className="space-y-5 lg:sticky lg:top-20">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Status</h2>
              <div className="space-y-2">
                <StatusChip label={DELIVERY_STATUS_LABELS[order.dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[order.dispatch.deliveryStatus]} />
                <br />
                <StatusChip label={INSTALLATION_STATUS_LABELS[order.installation.status]} variant={INSTALLATION_STATUS_VARIANT[order.installation.status]} />
              </div>
              {order.installation.assignedCs && (
                <p className="text-xs text-slate-400 mt-3">Assigned CS: {order.installation.assignedCs}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
