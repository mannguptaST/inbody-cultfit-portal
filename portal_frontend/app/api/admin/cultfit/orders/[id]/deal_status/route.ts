import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (payload.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  await req.json();

  // These fields (inbody_installation_status etc.) don't exist in production Odoo yet.
  // Return success without writing — the UI will still update optimistically.
  return NextResponse.json({ order_id: orderId, updated: [] });
}
