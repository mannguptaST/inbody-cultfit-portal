import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  submitPoData, LeadNotFoundError, PartnerNotMappedError, PoWorkflowError, type Authz,
} from '@/lib/odoo-server';
import { PoValidationError } from '@/lib/po-validation';
import { checkJsonMutation } from '@/lib/route-security';

// Step B — the only place PO data is ever written. Body is the customer's
// full reviewed/corrected values; every field is re-validated server-side
// (lib/po-validation.ts) regardless of what the extraction step returned.
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
    // Whitelisted, field-by-field, via validatePoSubmission — partner id,
    // salesperson id, PI version and quotation/attachment ids are never
    // read from `body` anywhere in this path.
    const result = await submitPoData(requestId, body, authz, user.email);
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof PoValidationError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof PoWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[po submit]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to submit PO data. Please try again later.' }, { status: 503 });
  }
}
