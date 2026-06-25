import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';
import { setCultFitStage } from '@/lib/odoo-server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (payload.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  const { stage } = await req.json();

  try {
    const result = await setCultFitStage(orderId, stage);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Stage set failed';
    return NextResponse.json({ detail: msg }, { status: 503 });
  }
}
