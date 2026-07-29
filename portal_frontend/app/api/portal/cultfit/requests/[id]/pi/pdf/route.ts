import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchPIPdfData, LeadNotFoundError, PartnerNotMappedError, type Authz } from '@/lib/odoo-server';

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
    const { data, filename } = await fetchPIPdfData(requestId, authz);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch (e: unknown) {
    // Not found and not-yet-published are deliberately indistinguishable to
    // the client — a safe 404 either way, never revealing whether a draft
    // PI silently exists for this request.
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: 'PI not found.' }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    console.error('[pi pdf download]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to download PI. Please try again later.' }, { status: 503 });
  }
}
