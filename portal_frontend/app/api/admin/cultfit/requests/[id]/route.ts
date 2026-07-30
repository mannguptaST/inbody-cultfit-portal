import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchAdminRequestDetail, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const detail = await fetchAdminRequestDetail(requestId, authz);
    if (!detail) return NextResponse.json({ detail: 'Request not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e: unknown) {
    console.error('[admin request detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load request. Please try again later.' }, { status: 503 });
  }
}
