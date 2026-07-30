import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { approvePoData, LeadNotFoundError, PoWorkflowError, type Authz } from '@/lib/odoo-server';

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

  try {
    const authz: Authz = { role: 'admin' };
    const result = await approvePoData(requestId, authz, user.email);
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof PoWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[po approve]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not approve PO. Please try again.' }, { status: 503 });
  }
}
