import { NextRequest, NextResponse } from 'next/server';
import { findUser, checkPassword, signJwt, setSessionCookie } from '@/lib/auth-server';

// Best-effort login rate limiting: an in-memory map keyed by IP+email.
// Known limitation, documented here and in PORTAL_SECURITY_AND_TESTING.md:
// this resets on cold start and is not shared across serverless instances,
// so it is a speed bump for casual guessing, not a hard guarantee. A real
// distributed limiter would need an external store (e.g. Vercel KV / Redis) —
// not worth adding for this app per the "no paid service unless required" rule.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
}

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ detail: 'Missing email or password' }, { status: 400 });
    }

    const key = `${clientIp(req)}:${String(email).toLowerCase().trim()}`;
    if (isRateLimited(key)) {
      return NextResponse.json({ detail: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    const user = findUser(email);
    if (!user || !checkPassword(password, user.password)) {
      // Same message whether the email is unknown or the password is wrong —
      // never reveal which, so an attacker can't enumerate valid accounts.
      return NextResponse.json({ detail: 'Invalid email or password' }, { status: 401 });
    }

    // Only identity goes in the token. Role/scope are always re-resolved from
    // PORTAL_USERS on every request (see requireAuthUser in auth-server.ts) so
    // a config change takes effect immediately, and no authorization decision
    // ever trusts a claim baked into a token that can be valid for 7 days.
    const token = signJwt({ sub: String(user.id), email: user.email });

    const res = NextResponse.json({ user: { name: user.name, email: user.email, role: user.role } });
    setSessionCookie(res, token);
    return res;
  } catch {
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
