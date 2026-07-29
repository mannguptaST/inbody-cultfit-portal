import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { fetchCultFitProductCatalog } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  try {
    const products = await fetchCultFitProductCatalog();
    return NextResponse.json({ products });
  } catch (e: unknown) {
    console.error('[cultfit products]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Failed to load products. Please try again later.' }, { status: 503 });
  }
}
