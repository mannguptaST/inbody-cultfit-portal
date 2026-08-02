import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchTerritoryList } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  try {
    const territories = await fetchTerritoryList();
    return NextResponse.json({ territories });
  } catch (e: unknown) {
    console.error('[admin territories]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load territories. Please try again later.' }, { status: 503 });
  }
}
