import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { setCultFitStage, LeadNotFoundError, InvalidStageError } from '@/lib/odoo-server';

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

  const { stage, reason } = await req.json();
  if (typeof stage !== 'string' || !stage) {
    return NextResponse.json({ detail: 'stage is required' }, { status: 400 });
  }

  try {
    const result = await setCultFitStage(orderId, stage, user.email, typeof reason === 'string' ? reason : '');
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof InvalidStageError) return NextResponse.json({ detail: e.message }, { status: 400 });
    console.error('[set_stage]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Could not update stage. Please try again.' }, { status: 503 });
  }
}
