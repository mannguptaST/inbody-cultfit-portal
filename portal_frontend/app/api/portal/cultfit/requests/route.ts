import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  createPortalOrderRequest, fetchPortalOrderRequests,
  InvalidRequestError, DuplicateRequestError, PartnerNotMappedError, type Authz,
} from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const requests = await fetchPortalOrderRequests(authz);
    return NextResponse.json({ requests });
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[requests list]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load requests. Please try again later.' }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const result = await createPortalOrderRequest(
      {
        // Whitelisted, field-by-field — contact details are deliberately not
        // read here at all (never trusted from the client; resolved
        // server-side from the existing CultFit contact structure instead).
        requestName: body.requestName,
        cocoFofo: body.cocoFofo,
        mainProductId: body.mainProductId,
        quantity: body.quantity,
        deliveryAddress: body.deliveryAddress,
        preferredDeliveryDate: body.preferredDeliveryDate,
        notes: body.notes,
      },
      authz,
      user.email,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof InvalidRequestError) {
      return NextResponse.json({ detail: e.message }, { status: 400 });
    }
    if (e instanceof DuplicateRequestError) {
      return NextResponse.json({ detail: e.message }, { status: 409 });
    }
    if (e instanceof PartnerNotMappedError) {
      return NextResponse.json({ detail: e.message }, { status: 403 });
    }
    console.error('[requests create]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to submit request. Please try again later.' }, { status: 503 });
  }
}
