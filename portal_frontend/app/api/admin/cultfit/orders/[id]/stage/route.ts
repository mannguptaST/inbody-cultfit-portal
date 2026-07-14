import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { updateCultFitStage, LeadNotFoundError } from '@/lib/odoo-server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ detail: 'Invalid order ID' }, { status: 400 });

  const { action, reason } = await req.json();
  if (action !== 'next' && action !== 'prev') {
    return NextResponse.json({ detail: "action must be 'next' or 'prev'" }, { status: 400 });
  }

  try {
    const result = await updateCultFitStage(orderId, action, user.email, typeof reason === 'string' ? reason : '');
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    console.error('[stage]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update stage. Please try again.' }, { status: 503 });
  }
}
