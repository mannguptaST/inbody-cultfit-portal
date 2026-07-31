import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { selectOrderInvoice, LeadNotFoundError, LogisticsWorkflowError, type Authz } from '@/lib/odoo-server';

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
  if (user.role !== 'logistics' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'Logistics access required' }, { status: 403 });
  }
  if (!isSameOrigin(req)) return NextResponse.json({ detail: 'Cross-origin request rejected.' }, { status: 403 });
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    return NextResponse.json({ detail: 'Content-Type must be application/json.' }, { status: 400 });
  }

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'logistics' };
    const invoice = await selectOrderInvoice(orderId, body.invoiceId, authz, user.email);
    return NextResponse.json({ invoice });
  } catch (e: unknown) {
    if (e instanceof LogisticsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[logistics invoice select]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not select invoice. Please try again.' }, { status: 503 });
  }
}
