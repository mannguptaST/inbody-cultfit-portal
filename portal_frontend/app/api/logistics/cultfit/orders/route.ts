import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchLogisticsOrderList, LogisticsWorkflowError, type Authz } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'logistics' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'Logistics access required' }, { status: 403 });
  }

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'logistics' };
    const orders = await fetchLogisticsOrderList(authz);
    return NextResponse.json({ orders });
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[logistics orders list]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load orders. Please try again later.' }, { status: 503 });
  }
}
