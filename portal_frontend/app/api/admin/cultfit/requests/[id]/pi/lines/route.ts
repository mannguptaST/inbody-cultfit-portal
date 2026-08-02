import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { addPIDraftLine, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';

// Same pattern as app/api/portal/cultfit/requests/route.ts.
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  if (!isSameOrigin(req)) {
    return NextResponse.json({ detail: 'Cross-origin request rejected.' }, { status: 403 });
  }
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    return NextResponse.json({ detail: 'Content-Type must be application/json.' }, { status: 400 });
  }

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  const body = await req.json().catch(() => null);
  const soId = Number(body?.soId);
  const productId = Number(body?.productId);
  if (!Number.isInteger(soId) || soId <= 0) return NextResponse.json({ detail: 'soId is required' }, { status: 400 });
  if (!Number.isInteger(productId) || productId <= 0) return NextResponse.json({ detail: 'productId is required' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await addPIDraftLine(requestId, soId, productId, body?.quantity, body?.unitPrice, authz, user.email);
    return NextResponse.json(draft, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[add PI line]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not add product line. Please try again.' }, { status: 503 });
  }
}
