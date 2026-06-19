// api.ts — All HTTP calls to the FastAPI backend.
// Every function reads the JWT from localStorage and sends it in Authorization header.

import { getToken } from '@/lib/auth';
import type {
  LoginResponse,
  Order,
  OrdersResponse,
  TimelineResponse,
  DocumentsResponse,
  CultFitOrder,
  CultFitOrdersResponse,
} from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

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

// Portal-only login — authenticates against local portal_users table (NOT Odoo).
// Use this for all portal logins (CultFit customers + InBody admin users).
export async function portalLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/portal/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// Odoo-based login — kept for internal use / debugging only. Not used by the UI.
export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function getOrders(centre?: string): Promise<OrdersResponse> {
  const qs = centre ? `?centre=${encodeURIComponent(centre)}` : '';
  return apiFetch<OrdersResponse>(`/portal/orders${qs}`);
}

export async function getOrderDetail(orderId: number): Promise<Order> {
  return apiFetch<Order>(`/portal/orders/${orderId}`);
}

export async function getOrderTimeline(orderId: number): Promise<TimelineResponse> {
  return apiFetch<TimelineResponse>(`/portal/orders/${orderId}/timeline`);
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function getDocuments(orderId: number): Promise<DocumentsResponse> {
  return apiFetch<DocumentsResponse>(`/portal/orders/${orderId}/documents`);
}

export async function downloadDocument(docId: number, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/portal/documents/${docId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError('DOWNLOAD_FAILED', 'Could not download document.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── CultFit Orders (XML-RPC backed, full field coverage) ─────────────────────

export async function getCultFitOrders(): Promise<CultFitOrdersResponse> {
  return apiFetch<CultFitOrdersResponse>('/portal/cultfit/orders');
}

export async function getCultFitOrderDetail(orderId: number): Promise<CultFitOrder> {
  return apiFetch<CultFitOrder>(`/portal/cultfit/orders/${orderId}`);
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

export interface DealStatusUpdate {
  payment_status?: string;
  installation_status?: string;
  vendor_portal_status?: string;
  confirmation_mail_sent?: boolean;
  md_approval_status?: string;
  reason?: string;
}

export async function updateDealStatus(
  orderId: number,
  updates: DealStatusUpdate,
): Promise<{ order_id: number; updated: string[] }> {
  return apiFetch(`/admin/cultfit/orders/${orderId}/deal_status`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
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

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function updateStage(
  orderId: number,
  action: 'next' | 'prev',
  reason = '',
): Promise<{ order_id: number; new_stage: string }> {
  return apiFetch(`/admin/orders/${orderId}/update_stage`, {
    method: 'POST',
    body: JSON.stringify({ action, reason }),
  });
}

export async function setStage(
  orderId: number,
  stage: string,
  reason = '',
  source = 'admin_manual',
): Promise<{ order_id: number; new_stage: string }> {
  return apiFetch(`/admin/orders/${orderId}/set_stage`, {
    method: 'POST',
    body: JSON.stringify({ stage, reason, source }),
  });
}
