'use client';
import Image from 'next/image';
import Link from 'next/link';

interface Props {
  role?: 'STAFF' | 'CUSTOMER' | 'ADMIN';
  userName?: string;
  search?: string;
  onSearchChange?: (v: string) => void;
  onRefresh?: () => void;
  onLogout?: () => void;
  backHref?: string;
  backLabel?: string;
  crumb?: string;
}

const ROLE_BADGE: Record<string, string> = {
  STAFF:    'bg-amber-50 text-amber-700 border border-amber-200',
  ADMIN:    'bg-violet-50 text-violet-700 border border-violet-200',
  CUSTOMER: 'bg-blue-50 text-blue-700 border border-blue-200',
};

export default function PortalHeader({
  role, userName, search, onSearchChange, onRefresh, onLogout,
  backHref, backLabel, crumb,
}: Props) {
  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 h-14 flex items-center gap-4">

        {/* Logo + role badge */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <Link href={backHref ?? '/'}>
            <Image src="/inbody-logo.webp" alt="InBody" width={72} height={22} className="object-contain" />
          </Link>
          {role && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${ROLE_BADGE[role] ?? ''}`}>
              {role}
            </span>
          )}
        </div>

        {/* Breadcrumb (detail pages) */}
        {backHref && backLabel && (
          <div className="hidden sm:flex items-center gap-2 text-sm flex-shrink-0">
            <span className="text-slate-300">/</span>
            <Link href={backHref} className="text-slate-500 hover:text-blue-600 transition-colors">
              {backLabel}
            </Link>
            {crumb && (
              <>
                <span className="text-slate-300">/</span>
                <span className="text-slate-800 font-mono font-medium truncate max-w-[200px]">{crumb}</span>
              </>
            )}
          </div>
        )}

        {/* Search — centered */}
        {onSearchChange !== undefined && (
          <div className="flex-1 min-w-0 max-w-lg mx-auto">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search orders, customer, centre, model..."
                value={search ?? ''}
                onChange={e => onSearchChange(e.target.value)}
                className="w-full pl-9 pr-8 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition"
              />
              {search && (
                <button
                  onClick={() => onSearchChange('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-base leading-none"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}

        {/* Right: user info + actions */}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {userName && (
            <span className="text-sm text-slate-600 hidden md:block max-w-[200px] truncate">
              {userName}
            </span>
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="hidden sm:inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white px-3 py-1.5 rounded-lg transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          )}
          {onLogout && (
            <button
              onClick={onLogout}
              className="text-sm text-slate-600 hover:text-red-600 border border-slate-200 hover:border-red-200 bg-white px-3 py-1.5 rounded-lg transition-all"
            >
              Sign out
            </button>
          )}
        </div>

      </div>
    </header>
  );
}
