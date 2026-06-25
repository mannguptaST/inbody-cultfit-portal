import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';
import { fetchCultFitOrderById } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const partnerId = Number(payload.partner_id) || 0;
    const order = await fetchCultFitOrderById(orderId, partnerId);
    if (!order) return NextResponse.json({ detail: 'Order not found' }, { status: 404 });
    return NextResponse.json(order);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch order';
    console.error('[order detail]', msg);
    return NextResponse.json({ detail: msg }, { status: 503 });
  }
}
