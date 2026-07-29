import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchPortalOrderRequestById, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

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
    const request = await fetchPortalOrderRequestById(requestId, authz);
    if (!request) return NextResponse.json({ detail: 'Request not found' }, { status: 404 });
    return NextResponse.json(request);
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[request detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load request. Please try again later.' }, { status: 503 });
  }
}
