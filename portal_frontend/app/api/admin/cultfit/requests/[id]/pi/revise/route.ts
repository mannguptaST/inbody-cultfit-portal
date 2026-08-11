import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { createPIRevision, LeadNotFoundError, PIWorkflowError, type Authz } from '@/lib/odoo-server';
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

  try {
    const authz: Authz = { role: 'admin' };
    const draft = await createPIRevision(requestId, authz, user.email);
    return NextResponse.json(draft, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PIWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[create PI revision]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not create PI revision. Please try again.' }, { status: 503 });
  }
}
