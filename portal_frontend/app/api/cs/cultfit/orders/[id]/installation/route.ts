import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  fetchCsOrderDetail, updateInstallationInfo, LeadNotFoundError, CsWorkflowError, type Authz,
} from '@/lib/odoo-server';

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'cs' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'CS access required' }, { status: 403 });
  }

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'cs' };
    const detail = await fetchCsOrderDetail(orderId, authz);
    if (!detail) return NextResponse.json({ detail: 'Order not found' }, { status: 404 });
    return NextResponse.json(detail.installation);
  } catch (e: unknown) {
    if (e instanceof CsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[cs installation get]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load installation info. Please try again later.' }, { status: 503 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'cs' && user.role !== 'admin') {
    return NextResponse.json({ detail: 'CS access required' }, { status: 403 });
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
    const authz: Authz = { role: user.role === 'admin' ? 'admin' : 'cs' };
    // Whitelisted, field-by-field — nothing beyond these named installation
    // fields is ever read from the request body, so a client can never
    // sneak in a partner/salesperson/product/CRM-stage field this way.
    const installation = await updateInstallationInfo(orderId, {
      status: body.status,
      scheduledDate: body.scheduledDate,
      scheduledTime: body.scheduledTime,
      installationNotes: body.installationNotes,
      completedOn: body.completedOn,
      completionNotes: body.completionNotes,
    }, authz, user.email);
    return NextResponse.json(installation);
  } catch (e: unknown) {
    if (e instanceof CsWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[cs installation update]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update installation info. Please try again.' }, { status: 503 });
  }
}
