import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchAttachmentData, PartnerNotMappedError, LeadNotFoundError, type Authz } from '@/lib/odoo-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  const { id, attachmentId } = await params;
  const orderId = parseInt(id, 10);
  const attId = parseInt(attachmentId, 10);
  if (isNaN(orderId) || isNaN(attId)) {
    return NextResponse.json({ detail: 'Invalid ID' }, { status: 400 });
  }

  try {
    const authz: Authz = user.role === 'admin' ? { role: 'admin' } : { role: 'customer', scope: user.scope };
    const { data, mimetype, filename } = await fetchAttachmentData(orderId, attId, authz);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': mimetype,
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      },
    });
  } catch (e: unknown) {
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: 'Attachment not found.' }, { status: 404 });
    console.error('[attachment download]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not download attachment. Please try again later.' }, { status: 503 });
  }
}
