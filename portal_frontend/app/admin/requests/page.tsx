'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAdminRequests } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { PI_STATUS_LABELS, PI_STATUS_VARIANT, PO_STATUS_LABELS, PO_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { AdminRequestSummary, User } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function productSummary(req: AdminRequestSummary): string {
  if (!req.details) return '—';
  const main = `${req.details.mainProduct.name} × ${req.details.quantity}`;
  return req.details.includedProducts.length ? `${main} (+${req.details.includedProducts.length} included)` : main;
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="px-5 py-4 flex items-center gap-6 animate-pulse">
          <div className="h-4 bg-slate-100 rounded w-20" />
          <div className="h-4 bg-slate-100 rounded w-32 hidden sm:block" />
          <div className="h-4 bg-slate-100 rounded w-24 hidden md:block" />
          <div className="h-5 bg-slate-100 rounded-full w-28 ml-auto" />
        </div>
      ))}
    </div>
  );
}

export default function AdminRequestsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<AdminRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (!isInBodyStaff(u.role)) { router.replace('/dashboard'); return; }
      setUser(u);
    });
  }, [router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getAdminRequests();
      setRequests(res.requests);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="STAFF" userName={user?.name} onRefresh={fetchRequests} onLogout={handleLogout} />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

        <div className="mb-7">
          <h1 className="text-xl font-semibold text-slate-900">Customer Requests</h1>
          <p className="text-sm text-slate-500 mt-0.5">New Order Requests submitted by customers through the portal</p>
        </div>

        {!loading && !error && (
          <p className="text-xs text-slate-400 mb-3">{requests.length} request{requests.length === 1 ? '' : 's'}</p>
        )}

        {loading && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <SkeletonRows />
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-sm text-red-700 font-medium mb-2">{error}</p>
            <button onClick={fetchRequests} className="text-sm text-blue-600 hover:underline">Try again</button>
          </div>
        )}

        {!loading && !error && requests.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-16 text-center shadow-sm">
            <p className="text-slate-700 font-medium">No requests yet</p>
            <p className="text-sm text-slate-400 mt-1">Customer-submitted order requests will appear here.</p>
          </div>
        )}

        {!loading && !error && requests.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '1250px' }}>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Reference</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Opportunity</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Products</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">COCO/FOFO</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Created</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">PI Status</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">PO Status</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Salesperson</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {requests.map(req => (
                    <tr
                      key={req.id}
                      onClick={() => router.push(`/admin/requests/${req.id}`)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer group"
                    >
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold text-blue-700 group-hover:text-blue-800">
                          REQ-{req.id}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-700" style={{ maxWidth: '220px' }}>
                        <span className="line-clamp-1">{req.name}</span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-600" style={{ maxWidth: '220px' }}>
                        <span className="line-clamp-1">{productSummary(req)}</span>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-600">
                        {req.details?.cocoFofo ?? '—'}
                      </td>
                      <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-xs">
                        {fmtDate(req.created_date)}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip label={PI_STATUS_LABELS[req.piStatus]} variant={PI_STATUS_VARIANT[req.piStatus]} />
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip label={PO_STATUS_LABELS[req.poStatus]} variant={PO_STATUS_VARIANT[req.poStatus]} />
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-500 text-xs">
                        {req.salesperson ?? 'Not yet assigned'}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right">
                        <span className="text-xs text-blue-600 group-hover:underline">View</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
