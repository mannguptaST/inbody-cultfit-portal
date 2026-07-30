import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { createDraftPI, updatePIDraft, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  const body = await req.json().catch(() => null);

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await createDraftPI(requestId, body?.mainProductPrice, authz, user.email);
    return NextResponse.json(draft, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[create draft PI]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not create draft PI. Please try again.' }, { status: 503 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  const body = await req.json().catch(() => null);
  const soId = Number(body?.soId);
  if (!Number.isInteger(soId) || soId <= 0) return NextResponse.json({ detail: 'soId is required' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await updatePIDraft(requestId, soId, {
      mainProductPrice: body?.mainProductPrice !== undefined ? Number(body.mainProductPrice) : undefined,
      validityDate: typeof body?.validityDate === 'string' ? body.validityDate : undefined,
    }, authz);
    return NextResponse.json(draft);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[update draft PI]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update draft PI. Please try again.' }, { status: 503 });
  }
}
