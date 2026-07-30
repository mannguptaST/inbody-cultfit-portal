import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  fetchPortalOrderRequestById, fetchCustomerPublishedPI,
  PartnerNotMappedError, LeadNotFoundError, type Authz,
} from '@/lib/odoo-server';

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

    // Best-effort: a PI-lookup failure must never break the rest of the
    // request detail page — the customer just sees "InBody is preparing
    // your PI" (the same as if none had been published yet).
    let pi: { status: string; snapshot: unknown } = { status: 'not_created', snapshot: null };
    try {
      pi = await fetchCustomerPublishedPI(requestId, authz);
    } catch (e) {
      if (!(e instanceof LeadNotFoundError)) {
        console.error('[request detail] failed to load PI status for', requestId, e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({ ...request, pi });
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[request detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load request. Please try again later.' }, { status: 503 });
  }
}
