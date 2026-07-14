import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchCultFitOrderById, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const authz: Authz = user.role === 'admin' ? { role: 'admin' } : { role: 'customer', scope: user.scope };
    const order = await fetchCultFitOrderById(orderId, authz);
    if (!order) return NextResponse.json({ detail: 'Order not found' }, { status: 404 });
    return NextResponse.json(order);
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[order detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to fetch order. Please try again later.' }, { status: 503 });
  }
}
