// auth-server.ts — Server-only JWT + user store.
// Never import this on the client side.

import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-CHANGE-IN-PRODUCTION';

// The session token lives only in an httpOnly cookie — never in localStorage,
// never in a JSON response body, never readable by client-side JS.
export const SESSION_COOKIE = 'portal_session';
const SESSION_MAX_AGE_SECONDS = 7 * 86_400;

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now    = Math.floor(Date.now() / 1000);
  const body   = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + SESSION_MAX_AGE_SECONDS })));
  const sig    = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest();
  const received  = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
  try {
    if (received.length !== expected.length || !timingSafeEqual(expected, received)) return null;
  } catch { return null; }
  const payload = JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

const ADMIN_PASS     = process.env.PORTAL_ADMIN_PASS     ?? '';
const CUSTOMER_PASS  = process.env.PORTAL_CUSTOMER_PASS  ?? '';
const LOGISTICS_EMAIL = process.env.PORTAL_LOGISTICS_EMAIL ?? '';
const LOGISTICS_PASS  = process.env.PORTAL_LOGISTICS_PASS  ?? '';

// A customer's data access is scoped one of two ways — never by trusting a
// partner id supplied by the client, always resolved server-side from here:
//   - 'cultfit_domain': the same CultFit/Curefit name-matching domain admin
//     sees, resolved fresh on every request. Used when a customer legitimately
//     represents the whole CultFit relationship across all of its ~45 regional
//     Odoo commercial-partner entities — new regions show up with no config
//     change needed.
//   - 'partner_ids': a fixed, explicit allowlist of Odoo commercial partner
//     ids. Use this for a future customer who should see only specific
//     partner(s), not the whole CultFit-style domain.
export type CustomerScope =
  | { kind: 'cultfit_domain' }
  | { kind: 'partner_ids'; partnerIds: number[] };

interface PortalUser {
  id: number;
  email: string;
  role: 'admin' | 'customer' | 'logistics';
  name: string;
  password: string;
  // Only meaningful for role === 'customer'. Missing/absent scope for a
  // customer account must never fall back to broad access — see odoo-server.ts.
  scope?: CustomerScope;
}

// The logistics account only exists in this list when BOTH env vars are
// configured — fail closed. A missing/partial config must never produce a
// user with an empty-string password (which checkPassword's timing-safe
// comparison would still technically "check" against, and an empty
// PORTAL_LOGISTICS_PASS would be trivially guessable) — it must simply not
// log in at all, the same way an unknown email doesn't, without touching
// admin/customer login at all.
const LOGISTICS_USER: PortalUser[] = (LOGISTICS_EMAIL && LOGISTICS_PASS)
  ? [{ id: 3, email: LOGISTICS_EMAIL, role: 'logistics', name: 'Logistics', password: LOGISTICS_PASS }]
  : [];

export const PORTAL_USERS: PortalUser[] = [
  { id: 1, email: 'admin@inbody.com',    role: 'admin',    name: 'InBody Admin', password: ADMIN_PASS },
  { id: 2, email: 'cultfit@curefit.com', role: 'customer', name: 'CultFit',      password: CUSTOMER_PASS, scope: { kind: 'cultfit_domain' } },
  ...LOGISTICS_USER,
];

export function findUser(email: string) {
  return PORTAL_USERS.find(u => u.email.toLowerCase() === email.toLowerCase().trim());
}

export function checkPassword(plain: string, stored: string): boolean {
  if (!plain || !stored) return false;
  const max = Math.max(plain.length, stored.length, 16);
  const a = Buffer.alloc(max, 0);
  const b = Buffer.alloc(max, 0);
  Buffer.from(plain).copy(a);
  Buffer.from(stored).copy(b);
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export interface AuthedUser {
  id: number;
  email: string;
  role: 'admin' | 'customer' | 'logistics';
  name: string;
  scope?: CustomerScope;
}

// Reads the session token from the httpOnly cookie (never a header, never
// anything the client could set directly), verifies it, then re-resolves
// the user's current role/scope from PORTAL_USERS — every protected route
// uses this so authorization always reflects live config, never a claim
// baked into a token that may be valid for up to 7 days.
export function requireAuthUser(req: NextRequest): AuthedUser | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifyJwt(token);
  if (!payload) return null;
  const user = findUser(String(payload.email ?? ''));
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role, name: user.name, scope: user.scope };
}
