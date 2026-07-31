import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';

// Next.js 16 renamed "middleware" to "proxy" (this file used to be
// middleware.ts). Proxy defaults to the Node.js runtime already — do not add
// `export const runtime = 'nodejs'` here, Next.js throws a build error if a
// runtime config is set in a proxy file.

const STAFF_HOME = '/admin';
const CUSTOMER_HOME = '/dashboard';
const LOGISTICS_HOME = '/logistics';

function homeFor(role: string): string {
  if (role === 'admin') return STAFF_HOME;
  if (role === 'logistics') return LOGISTICS_HOME;
  return CUSTOMER_HOME;
}

// Server-side page gating so an unauthenticated or wrong-role user is
// redirected before the page ever renders — not just via the client-side
// useEffect checks the pages already have. The real data boundary is still
// every API route's own requireAuthUser() check; this is defense in depth
// for page navigation specifically.
export function proxy(req: NextRequest) {
  const user = requireAuthUser(req);
  const { pathname } = req.nextUrl;

  if (!user) {
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith('/admin') && user.role !== 'admin') {
    return NextResponse.redirect(new URL(homeFor(user.role), req.url));
  }

  // Admin may also view logistics information (spec §2) — logistics pages
  // are gated to 'logistics' OR 'admin', same as the API routes underneath.
  if (pathname.startsWith('/logistics') && user.role !== 'logistics' && user.role !== 'admin') {
    return NextResponse.redirect(new URL(homeFor(user.role), req.url));
  }

  if ((pathname.startsWith('/dashboard') || pathname.startsWith('/requests')) && user.role !== 'customer') {
    return NextResponse.redirect(new URL(homeFor(user.role), req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/dashboard/:path*', '/orders/:path*', '/requests/:path*', '/logistics/:path*'],
};
