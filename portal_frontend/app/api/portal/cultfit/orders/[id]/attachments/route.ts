import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchOrderAttachments, PartnerNotMappedError, LeadNotFoundError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  try {
    const authz: Authz = user.role === 'admin' ? { role: 'admin' } : { role: 'customer', scope: user.scope };
    const attachments = await fetchOrderAttachments(orderId, authz);
    return NextResponse.json({ attachments, count: attachments.length });
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[attachments]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not fetch attachments. Please try again later.' }, { status: 503 });
  }
}
