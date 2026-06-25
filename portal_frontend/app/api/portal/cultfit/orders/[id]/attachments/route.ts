import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  await params;
  return NextResponse.json({ attachments: [], count: 0 });
}
