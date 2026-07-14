import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchCultFitOrders, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  try {
    const authz: Authz = user.role === 'admin' ? { role: 'admin' } : { role: 'customer', scope: user.scope };
    const result = await fetchCultFitOrders(authz);
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[orders]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to fetch orders. Please try again later.' }, { status: 503 });
  }
}
