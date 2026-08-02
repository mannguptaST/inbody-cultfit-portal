// route-security.ts — shared same-origin / Content-Type checks for every
// mutating (POST/PATCH/PUT/DELETE) API route. Previously this was a
// near-identical function copy-pasted into ~10 route files independently;
// this is the one place it lives now. Unsupported HTTP methods on a route
// don't need handling here — Next.js's own App Router returns 405 for any
// method a route.ts file doesn't export a handler for.

import 'server-only';
import type { NextRequest } from 'next/server';

// Origins this app's mutating routes accept requests from. Always includes
// the domain the current request itself arrived on — safe to trust on
// Vercel specifically, because the platform terminates TLS/routes per
// registered domain at the edge, so a client cannot spoof Host to reach
// this deployment under a different apparent origin. That alone already
// covers every Preview deployment (each gets its own real domain) and
// Production without enumerating them. ALLOWED_ORIGINS is an optional,
// explicit comma-separated allowlist for any additional legitimate origin
// (e.g. a custom domain) an operator wants to add without a code change —
// strictly additive, never a replacement for the self-derived check.
// Deliberately never reads X-Forwarded-Host or any other client-suppliable
// header — those can be influenced by an untrusted intermediary.
function resolveAllowedOrigins(req: NextRequest): Set<string> {
  const origins = new Set<string>([req.nextUrl.origin]);
  const extra = process.env.ALLOWED_ORIGINS;
  if (extra) {
    for (const raw of extra.split(',')) {
      const trimmed = raw.trim().replace(/\/+$/, '');
      if (trimmed) origins.add(trimmed);
    }
  }
  return origins;
}

// Only enforced when the browser actually sends an Origin header — always
// true for same-origin fetch mutations from this app's own client code, so
// this adds a real CSRF mitigation without risking false rejections of
// requests that legitimately omit it.
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return resolveAllowedOrigins(req).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function hasContentType(req: NextRequest, needle: string): boolean {
  return (req.headers.get('content-type') ?? '').toLowerCase().includes(needle);
}

export interface SecurityRejection {
  detail: string;
  status: 400 | 403 | 415;
}

// The check nearly every mutating JSON route needs: cross-origin first,
// then wrong body type. Callers still do their own auth/role check first
// (that differs per route) and their own field whitelisting after this
// passes — this only ever guards the transport-level shape of the request.
export function checkJsonMutation(req: NextRequest): SecurityRejection | null {
  if (!isSameOrigin(req)) return { detail: 'Cross-origin request rejected.', status: 403 };
  if (!hasContentType(req, 'application/json')) {
    return { detail: 'Content-Type must be application/json.', status: 400 };
  }
  return null;
}

// For the one file-upload route (PO PDF extraction) — same origin check,
// multipart instead of JSON.
export function checkMultipartMutation(req: NextRequest): SecurityRejection | null {
  if (!isSameOrigin(req)) return { detail: 'Cross-origin request rejected.', status: 403 };
  if (!hasContentType(req, 'multipart/form-data')) {
    return { detail: 'Content-Type must be multipart/form-data.', status: 415 };
  }
  return null;
}

// For mutations with no request body at all (e.g. logout, or a DELETE that
// only takes a query param) — origin check only, no Content-Type
// requirement, since a genuinely bodyless request has none to validate.
export function checkBodylessMutation(req: NextRequest): SecurityRejection | null {
  if (!isSameOrigin(req)) return { detail: 'Cross-origin request rejected.', status: 403 };
  return null;
}
