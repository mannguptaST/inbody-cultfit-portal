'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getOrderRequests } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { STAGE_KEYS, REQUEST_STAGE_LABELS, STAGE_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { PortalRequestSummary, User } from '@/types';

type SortKey = 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'updated_desc', label: 'Latest updated' },
  { value: 'updated_asc', label: 'Oldest updated' },
  { value: 'created_desc', label: 'Newest first' },
  { value: 'created_asc', label: 'Oldest first' },
];

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function productSummary(req: PortalRequestSummary): string {
  if (!req.details) return '—';
  const main = `${req.details.mainProduct.name} × ${req.details.quantity}`;
  return req.details.includedProducts.length ? `${main} (+${req.details.includedProducts.length} included)` : main;
}

function sortRequests(items: PortalRequestSummary[], sort: SortKey): PortalRequestSummary[] {
  const copy = [...items];
  switch (sort) {
    case 'updated_asc':
      return copy.sort((a, b) => (a.last_updated ?? '').localeCompare(b.last_updated ?? ''));
    case 'created_asc':
      return copy.sort((a, b) => (a.created_date ?? '').localeCompare(b.created_date ?? ''));
    case 'created_desc':
      return copy.sort((a, b) => (b.created_date ?? '').localeCompare(a.created_date ?? ''));
    case 'updated_desc':
    default:
      return copy.sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''));
  }
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

export default function MyRequestsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<PortalRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('updated_desc');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (isInBodyStaff(u.role)) { router.replace('/admin'); return; }
      setUser(u);
    });
  }, [router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getOrderRequests();
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

  const filtered = sortRequests(
    requests.filter(r => {
      const q = search.toLowerCase();
      const matchSearch =
        !q ||
        r.name.toLowerCase().includes(q) ||
        (r.details?.deliveryAddress ?? '').toLowerCase().includes(q) ||
        (r.details?.mainProduct.name ?? '').toLowerCase().includes(q);
      const matchStage = !stageFilter || r.portal_stage === stageFilter;
      return matchSearch && matchStage;
    }),
    sort,
  );

  const hasFilters = Boolean(search || stageFilter);

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader
        role="CUSTOMER"
        userName={user?.name ?? user?.company ?? undefined}
        search={search}
        onSearchChange={setSearch}
        onLogout={handleLogout}
      />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

        <div className="flex flex-wrap items-center justify-between gap-3 mb-7">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">My Requests</h1>
            <p className="text-sm text-slate-500 mt-0.5">Order requests you&apos;ve submitted through the portal</p>
          </div>
          <Link
            href="/requests/new"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            + New Order Request
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            value={stageFilter}
            onChange={e => setStageFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[170px]"
          >
            <option value="">All Statuses</option>
            {STAGE_KEYS.map(k => (
              <option key={k} value={k}>{REQUEST_STAGE_LABELS[k] ?? k}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[170px]"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>Sort: {o.label}</option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={() => { setSearch(''); setStageFilter(''); }}
              className="text-xs text-blue-600 hover:text-blue-700 underline"
            >
              Clear filters
            </button>
          )}
          {!loading && (
            <p className="text-xs text-slate-400 sm:ml-auto">{filtered.length} of {requests.length} requests</p>
          )}
        </div>

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

        {!loading && !error && filtered.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-16 text-center shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <p className="text-slate-700 font-medium">No requests found</p>
            <p className="text-sm text-slate-400 mt-1">
              {hasFilters ? 'Try adjusting your filters.' : 'You haven&apos;t submitted any order requests yet.'}
            </p>
            {!hasFilters && (
              <Link href="/requests/new" className="inline-block mt-4 text-sm text-blue-600 hover:underline">
                Submit your first request
              </Link>
            )}
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Reference</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Request Name</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">COCO/FOFO</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Products</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Submitted</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Status</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Representative</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(req => (
                    <tr
                      key={req.id}
                      onClick={() => router.push(`/requests/${req.id}`)}
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
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-600">
                        {req.details?.cocoFofo ?? '—'}
                      </td>
                      <td className="px-5 py-3.5 text-slate-600" style={{ maxWidth: '220px' }}>
                        <span className="line-clamp-1">{productSummary(req)}</span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-xs">
                        {fmtDate(req.created_date)}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip label={req.portal_stage_label} variant={STAGE_VARIANT[req.portal_stage] ?? 'neutral'} />
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-500 text-xs">
                        {req.salesperson ?? 'Not yet assigned'}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right">
                        <span className="text-xs text-blue-600 group-hover:underline">View Details</span>
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
