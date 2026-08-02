import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
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
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });
  await req.json().catch(() => null);

  // payment_status / installation_status / vendor_portal_status / md_approval_status /
  // confirmation_mail_sent have no backing field on crm.lead in production Odoo — there is
  // nothing to write. Previously this route silently returned 200 with `updated: []`,
  // which the UI read as "Deal status updated and logged" even though nothing was saved.
  // Report that honestly instead of faking success.
  return NextResponse.json(
    { detail: 'Deal status fields are not available in production Odoo yet — nothing was saved.' },
    { status: 501 },
  );
}
