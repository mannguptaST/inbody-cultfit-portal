import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  updateCustomerDispatchAddress, LeadNotFoundError, LogisticsWorkflowError, PartnerNotMappedError, type Authz,
} from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

// Narrow, Customer-only entry point for the Dispatch / Final Delivery
// Address. Deliberately a separate route from the Admin/Logistics
// PATCH /logistics/cultfit/orders/[id]/dispatch — that route accepts the
// full Delivery Tracking payload and is role-gated admin/logistics-only, so
// opening it to Customer would require either trusting a client-suppliable
// field whitelist or relaxing that gate. This route can only ever read one
// field from the body, no matter what a client sends.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const dispatch = await updateCustomerDispatchAddress(requestId, body.dispatchAddress, authz, user.email);
    return NextResponse.json(dispatch);
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[customer dispatch address update]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update the delivery address. Please try again.' }, { status: 503 });
  }
}
