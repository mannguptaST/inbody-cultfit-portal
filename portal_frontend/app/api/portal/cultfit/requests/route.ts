import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  createPortalOrderRequest, fetchPortalOrderRequests,
  InvalidRequestError, DuplicateRequestError, PartnerNotMappedError, type Authz,
} from '@/lib/odoo-server';

// Same-origin check for the mutating POST below — only enforced when the
// browser actually sends an Origin header (it always does for same-origin
// fetch POSTs from this app), so it adds a real check without risking false
// rejections of legitimate requests that omit it.
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

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

  if (!isSameOrigin(req)) {
    return NextResponse.json({ detail: 'Cross-origin request rejected.' }, { status: 403 });
  }
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    return NextResponse.json({ detail: 'Content-Type must be application/json.' }, { status: 400 });
  }

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
