// auth.ts — Client-side session helpers.
// The session token itself lives only in an httpOnly cookie (set by the
// login API route) — this file never reads, writes, or stores it. "Who am
// I" is always answered by asking the server (/api/portal/auth/me), which
// verifies the cookie itself; the client never decides this on its own.

import type { User } from '@/types';

export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const res = await fetch('/api/portal/auth/me');
    if (!res.ok) return null;
    return (await res.json()) as User;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/portal/auth/logout', { method: 'POST' });
  } catch {
    // Best effort — even if this fails, redirecting to /login and letting
    // the (now likely still-valid) cookie fail server-side checks is safe.
  }
}

export function isInBodyStaff(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'inbody_manager' || role === 'inbody_user';
}

export function isLogistics(role: string | null | undefined): boolean {
  return role === 'logistics';
}

export function isCs(role: string | null | undefined): boolean {
  return role === 'cs';
}
