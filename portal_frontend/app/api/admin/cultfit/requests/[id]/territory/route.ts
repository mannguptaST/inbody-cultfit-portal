import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { updateRequestTerritory, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  const body = await req.json().catch(() => null);
  const territoryId = Number(body?.territoryId);
  if (!Number.isInteger(territoryId) || territoryId <= 0) {
    return NextResponse.json({ detail: 'territoryId is required' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'admin' };
    const territory = await updateRequestTerritory(requestId, territoryId, authz, user.email);
    return NextResponse.json({ territory });
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[update territory]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update Territory. Please try again.' }, { status: 503 });
  }
}
