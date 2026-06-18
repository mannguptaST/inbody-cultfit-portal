// auth.ts — Token storage and user session management
// Stores JWT in localStorage for the MVP.

import type { User } from '@/types';

const TOKEN_KEY = 'inbody_portal_token';
const USER_KEY  = 'inbody_portal_user';

export function saveSession(token: string, user: User): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as User; }
  catch { return null; }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    // Decode JWT payload (second part, base64)
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function getUserRole(): string | null {
  const user = getUser();
  return user?.role ?? null;
}

export function isInBodyStaff(): boolean {
  const role = getUserRole();
  return role === 'inbody_manager' || role === 'inbody_user' || role === 'admin';
}
