// auth-server.ts — Server-only JWT + user store.
// Never import this on the client side.

import { createHmac, timingSafeEqual } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-CHANGE-IN-PRODUCTION';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now    = Math.floor(Date.now() / 1000);
  const body   = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 7 * 86_400 })));
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

const ADMIN_PASS    = process.env.PORTAL_ADMIN_PASS    ?? '';
const CUSTOMER_PASS = process.env.PORTAL_CUSTOMER_PASS ?? '';

export const PORTAL_USERS = [
  { id: 1, email: 'admin@inbody.com',    role: 'admin' as const,    name: 'InBody Admin', password: ADMIN_PASS,    partner_id: 0 },
  { id: 2, email: 'guru@cultfittest.in', role: 'customer' as const, name: 'Guru',         password: CUSTOMER_PASS, partner_id: 0 },
  { id: 3, email: 'vijay@cultfittest.in',role: 'customer' as const, name: 'Vijay',        password: CUSTOMER_PASS, partner_id: 0 },
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

export function requireAuth(authHeader: string | null): Record<string, unknown> | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return verifyJwt(authHeader.slice(7));
}
