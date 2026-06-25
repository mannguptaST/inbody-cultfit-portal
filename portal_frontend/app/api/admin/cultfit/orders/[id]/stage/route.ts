import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';
import { updateCultFitStage } from '@/lib/odoo-server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (payload.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  const { action } = await req.json();

  if (action !== 'next' && action !== 'prev') {
    return NextResponse.json({ detail: "action must be 'next' or 'prev'" }, { status: 400 });
  }

  try {
    const result = await updateCultFitStage(orderId, action);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Stage update failed';
    return NextResponse.json({ detail: msg }, { status: 503 });
  }
}
