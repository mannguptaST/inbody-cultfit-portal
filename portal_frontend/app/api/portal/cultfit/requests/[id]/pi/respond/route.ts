import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  respondToPublishedPI, InvalidRequestError, LeadNotFoundError, PartnerNotMappedError, type Authz,
} from '@/lib/odoo-server';
import { checkJsonMutation } from '@/lib/route-security';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const rejection = checkJsonMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const result = await respondToPublishedPI(requestId, body.action, body.comment, authz, user.email);
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof InvalidRequestError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[pi respond]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to submit response. Please try again later.' }, { status: 503 });
  }
}
