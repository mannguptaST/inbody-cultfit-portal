import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchLogisticsOrderDetail, LogisticsWorkflowError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'logistics' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'Logistics access required' }, { status: 403 });
  }

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'logistics' };
    const detail = await fetchLogisticsOrderDetail(orderId, authz);
    if (!detail) return NextResponse.json({ detail: 'Order not found' }, { status: 404 });
    return NextResponse.json({ candidates: detail.invoiceCandidates, selected: detail.selectedInvoice });
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[logistics invoices]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load invoices. Please try again later.' }, { status: 503 });
  }
}
