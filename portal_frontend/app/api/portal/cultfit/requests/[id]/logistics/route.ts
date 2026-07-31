import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchCustomerLogisticsView, LeadNotFoundError, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const view = await fetchCustomerLogisticsView(requestId, authz);
    return NextResponse.json(view);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[customer logistics view]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load logistics info. Please try again later.' }, { status: 503 });
  }
}
