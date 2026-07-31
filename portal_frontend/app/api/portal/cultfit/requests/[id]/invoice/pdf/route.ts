import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchInvoicePdfData, LeadNotFoundError, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const { data, filename } = await fetchInvoicePdfData(requestId, authz);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch (e: unknown) {
    // No linked/selected invoice and not-found are deliberately
    // indistinguishable — a safe 404 either way.
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: 'Invoice not found.' }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[invoice pdf download]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to download invoice. Please try again later.' }, { status: 503 });
  }
}
