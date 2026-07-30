import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchAdminRequestList, type Authz } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  try {
    const authz: Authz = { role: 'admin' };
    const requests = await fetchAdminRequestList(authz);
    return NextResponse.json({ requests });
  } catch (e: unknown) {
    console.error('[admin requests list]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load requests. Please try again later.' }, { status: 503 });
  }
}
