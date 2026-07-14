// api.ts — All HTTP calls to this app's own Next.js API routes.
// Auth is an httpOnly cookie, sent automatically by the browser on every
// same-origin fetch — nothing here ever reads or attaches a token.

import type {
  LoginResponse,
  CultFitOrder,
  CultFitOrdersResponse,
} from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body?.error?.code ?? body?.detail ?? 'UNKNOWN',
      body?.error?.message ?? body?.detail ?? `HTTP ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function portalLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/portal/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// ── CultFit Orders (XML-RPC backed, full field coverage) ─────────────────────

export async function getCultFitOrders(): Promise<CultFitOrdersResponse> {
  return apiFetch<CultFitOrdersResponse>('/portal/cultfit/orders');
}

export async function getCultFitOrderDetail(orderId: number): Promise<CultFitOrder> {
  return apiFetch<CultFitOrder>(`/portal/cultfit/orders/${orderId}`);
}

export async function setCultFitPortalStage(
  orderId: number,
  stage: string,
  reason = '',
): Promise<{ order_id: number; new_stage: string; new_stage_label: string }> {
  return apiFetch(`/admin/cultfit/orders/${orderId}/set_stage`, {
    method: 'POST',
    body: JSON.stringify({ stage, reason }),
  });
}

export async function updateCultFitStage(
  orderId: number,
  action: 'next' | 'prev',
  reason = '',
): Promise<{ order_id: number; new_stage: string; new_stage_label: string }> {
  return apiFetch(`/admin/cultfit/orders/${orderId}/stage`, {
    method: 'POST',
    body: JSON.stringify({ action, reason }),
  });
}

// ── CultFit Odoo Attachments ──────────────────────────────────────────────────

export interface OdooAttachment {
  id: number;
  name: string;
  type: 'quotation' | 'invoice';
  label: string;
  size: number;
  date: string | null;
  mimetype: string;
}

export async function getOdooAttachments(
  orderId: number,
): Promise<{ attachments: OdooAttachment[]; count: number }> {
  return apiFetch(`/portal/cultfit/orders/${orderId}/attachments`);
}
