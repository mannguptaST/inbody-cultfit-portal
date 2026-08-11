import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { updatePIDraftLine, removePIDraftLine, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';
import { checkJsonMutation, checkBodylessMutation } from '@/lib/route-security';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

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
      discCalculation: body?.discCalculation === 'fixed' ? 'fixed' : body?.discCalculation === 'percentage' ? 'percentage' : undefined,
      discount: body?.discount !== undefined ? Number(body.discount) : undefined,
      fixedAmount: body?.fixedAmount !== undefined ? Number(body.fixedAmount) : undefined,
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

  const rejection = checkBodylessMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

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
