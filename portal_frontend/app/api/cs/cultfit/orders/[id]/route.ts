import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchCsOrderDetail, CsWorkflowError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'cs' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'CS access required' }, { status: 403 });
  }

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'cs' };
    const detail = await fetchCsOrderDetail(orderId, authz);
    if (!detail) return NextResponse.json({ detail: 'Order not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e: unknown) {
    if (e instanceof CsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[cs order detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load order. Please try again later.' }, { status: 503 });
  }
}
