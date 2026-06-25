import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';
import { fetchCultFitOrders } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  try {
    const partnerId = Number(payload.partner_id) || 0;
    const result = await fetchCultFitOrders(partnerId);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch orders';
    console.error('[orders]', msg);
    return NextResponse.json({ detail: msg }, { status: 503 });
  }
}
