import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchAdminPoDetail, LeadNotFoundError, type Authz } from '@/lib/odoo-server';

// Lighter-weight than GET /api/admin/cultfit/requests/[id] (which also
// includes the full PO block) — kept as its own route since the admin PO
// panel can refresh independently after Approve/Request Correction.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  try {
    const authz: Authz = { role: 'admin' };
    const po = await fetchAdminPoDetail(requestId, authz);
    return NextResponse.json(po);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[admin po detail]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load PO details. Please try again later.' }, { status: 503 });
  }
}
