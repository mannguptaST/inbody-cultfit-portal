import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth-server';
import { checkBodylessMutation } from '@/lib/route-security';

export async function POST(req: NextRequest) {
  const rejection = checkBodylessMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
