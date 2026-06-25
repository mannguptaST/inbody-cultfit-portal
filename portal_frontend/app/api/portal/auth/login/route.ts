import { NextRequest, NextResponse } from 'next/server';
import { findUser, checkPassword, signJwt } from '@/lib/auth-server';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ detail: 'Missing email or password' }, { status: 400 });
    }
    const user = findUser(email);
    if (!user || !checkPassword(password, user.password)) {
      return NextResponse.json({ detail: 'Invalid email or password' }, { status: 401 });
    }
    const token = signJwt({ sub: String(user.id), role: user.role, email: user.email, partner_id: user.partner_id });
    return NextResponse.json({
      token,
      expires_in: 7 * 86_400,
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch {
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
