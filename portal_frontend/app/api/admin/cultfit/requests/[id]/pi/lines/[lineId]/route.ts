import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { updatePIDraftLine, removePIDraftLine, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
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

  const { id, lineId } = await params;
  const requestId = parseInt(id, 10);
  const parsedLineId = parseInt(lineId, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });
  if (isNaN(parsedLineId)) return NextResponse.json({ detail: 'Invalid line ID' }, { status: 400 });

  const body = await req.json().catch(() => null);
  const soId = Number(body?.soId);
  if (!Number.isInteger(soId) || soId <= 0) return NextResponse.json({ detail: 'soId is required' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await updatePIDraftLine(requestId, soId, parsedLineId, {
      quantity: body?.quantity !== undefined ? Number(body.quantity) : undefined,
      unitPrice: body?.unitPrice !== undefined ? Number(body.unitPrice) : undefined,
    }, authz);
    return NextResponse.json(draft);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[update PI line]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update product line. Please try again.' }, { status: 503 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  if (!isSameOrigin(req)) {
    return NextResponse.json({ detail: 'Cross-origin request rejected.' }, { status: 403 });
  }

  const { id, lineId } = await params;
  const requestId = parseInt(id, 10);
  const parsedLineId = parseInt(lineId, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });
  if (isNaN(parsedLineId)) return NextResponse.json({ detail: 'Invalid line ID' }, { status: 400 });

  const soId = Number(req.nextUrl.searchParams.get('soId'));
  if (!Number.isInteger(soId) || soId <= 0) return NextResponse.json({ detail: 'soId is required' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await removePIDraftLine(requestId, soId, parsedLineId, authz, user.email);
    return NextResponse.json(draft);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[remove PI line]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not remove product line. Please try again.' }, { status: 503 });
  }
}
