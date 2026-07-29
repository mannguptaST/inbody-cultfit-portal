import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchEligibleSalespeople } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  try {
    const salespeople = await fetchEligibleSalespeople();
    return NextResponse.json({ salespeople });
  } catch (e: unknown) {
    console.error('[admin salespeople]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load salespeople. Please try again later.' }, { status: 503 });
  }
}
