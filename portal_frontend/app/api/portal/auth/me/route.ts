import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, findUser } from '@/lib/auth-server';

export async function GET(req: NextRequest) {
  const payload = requireAuth(req.headers.get('authorization'));
  if (!payload) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });

  const user = findUser(payload.email as string);
  if (!user) return NextResponse.json({ detail: 'User not found' }, { status: 401 });

  return NextResponse.json({ name: user.name, email: user.email, role: user.role });
}
