import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { assignSalesperson, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

export async function POST(
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
  const salespersonId = Number(body?.salespersonId);
  if (!Number.isInteger(salespersonId) || salespersonId <= 0) {
    return NextResponse.json({ detail: 'salespersonId is required' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'admin' };
    const salesperson = await assignSalesperson(requestId, salespersonId, authz, user.email);
    return NextResponse.json({ salesperson });
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[assign salesperson]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not assign salesperson. Please try again.' }, { status: 503 });
  }
}
