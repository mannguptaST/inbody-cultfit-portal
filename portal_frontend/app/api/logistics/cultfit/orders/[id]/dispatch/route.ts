import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  fetchLogisticsOrderDetail, updateDispatchInfo, LeadNotFoundError, LogisticsWorkflowError, type Authz,
} from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

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
    return NextResponse.json(detail.dispatch);
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[logistics dispatch get]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load dispatch info. Please try again later.' }, { status: 503 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'logistics' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'Logistics access required' }, { status: 403 });
  }
  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'logistics' };
    // Whitelisted, field-by-field — nothing beyond these named dispatch
    // fields is ever read from the request body, so a client can never
    // sneak in a partner/salesperson/picking/model field this way.
    const dispatch = await updateDispatchInfo(orderId, {
      dispatchDate: body.dispatchDate,
      courier: body.courier,
      awb: body.awb,
      trackingUrl: body.trackingUrl,
      expectedDeliveryDate: body.expectedDeliveryDate,
      actualDeliveryDate: body.actualDeliveryDate,
      deliveryStatus: body.deliveryStatus,
      logisticsNote: body.logisticsNote,
      dispatchAddress: body.dispatchAddress,
    }, authz, user.email);
    return NextResponse.json(dispatch);
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[logistics dispatch update]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update dispatch info. Please try again.' }, { status: 503 });
  }
}
