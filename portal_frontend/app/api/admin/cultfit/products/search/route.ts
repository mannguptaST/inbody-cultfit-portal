import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import { searchAdminProducts } from '@/lib/odoo-server';

export async function GET(req: NextRequest) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Admin access required' }, { status: 403 });

  const q = req.nextUrl.searchParams.get('q') ?? '';

  try {
    const products = await searchAdminProducts(q);
    return NextResponse.json({ products });
  } catch (e: unknown) {
    console.error('[admin product search]', e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: 'Product search failed. Please try again later.' }, { status: 503 });
  }
}
