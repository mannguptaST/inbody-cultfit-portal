// api.ts — All HTTP calls to this app's own Next.js API routes.
// Auth is an httpOnly cookie, sent automatically by the browser on every
// same-origin fetch — nothing here ever reads or attaches a token.

import type {
  LoginResponse,
  CultFitOrder,
  CultFitOrdersResponse,
  CultFitProductOption,
  PortalRequestSummary,
  PortalRequestDetail,
  NewOrderRequestPayload,
  EligibleSalesperson,
  AdminRequestSummary,
  AdminRequestDetail,
  PIDraftInfo,
  PIPublishedSnapshot,
  CustomerPIView,
  PIStatus,
  ExtractedPoData,
  PortalPoData,
  PoCustomerView,
  PoAdminView,
  PoSubmitResult,
  PoApproveResult,
  PoCorrectionResult,
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

// ── New Order Request (Phase 1) ───────────────────────────────────────────────

export async function getCultFitProducts(): Promise<{ products: CultFitProductOption[] }> {
  return apiFetch('/portal/cultfit/products');
}

export async function submitOrderRequest(
  payload: NewOrderRequestPayload,
): Promise<{ id: number; name: string }> {
  return apiFetch('/portal/cultfit/requests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getOrderRequests(): Promise<{ requests: PortalRequestSummary[] }> {
  return apiFetch('/portal/cultfit/requests');
}

export async function getOrderRequestDetail(id: number): Promise<PortalRequestDetail & { pi: CustomerPIView }> {
  return apiFetch(`/portal/cultfit/requests/${id}`);
}

// ── Phase 2: PI workflow ──────────────────────────────────────────────────────

export async function respondToPI(
  id: number, action: 'confirm' | 'request_correction', comment?: string,
): Promise<{ status: PIStatus }> {
  return apiFetch(`/portal/cultfit/requests/${id}/pi/respond`, {
    method: 'POST',
    body: JSON.stringify({ action, comment }),
  });
}

export function getPIDownloadUrl(id: number): string {
  return `${API_BASE}/portal/cultfit/requests/${id}/pi/pdf`;
}

export async function getAdminRequests(): Promise<{ requests: AdminRequestSummary[] }> {
  return apiFetch('/admin/cultfit/requests');
}

export async function getAdminRequestDetail(id: number): Promise<AdminRequestDetail> {
  return apiFetch(`/admin/cultfit/requests/${id}`);
}

export async function getEligibleSalespeople(): Promise<{ salespeople: EligibleSalesperson[] }> {
  return apiFetch('/admin/cultfit/salespeople');
}

export async function assignRequestSalesperson(
  id: number, salespersonId: number,
): Promise<{ salesperson: EligibleSalesperson }> {
  return apiFetch(`/admin/cultfit/requests/${id}/salesperson`, {
    method: 'POST',
    body: JSON.stringify({ salespersonId }),
  });
}

export async function createDraftPI(id: number, mainProductPrice: number): Promise<PIDraftInfo> {
  return apiFetch(`/admin/cultfit/requests/${id}/pi`, {
    method: 'POST',
    body: JSON.stringify({ mainProductPrice }),
  });
}

export async function createPIRevision(id: number, mainProductPrice: number): Promise<PIDraftInfo> {
  return apiFetch(`/admin/cultfit/requests/${id}/pi/revise`, {
    method: 'POST',
    body: JSON.stringify({ mainProductPrice }),
  });
}

export async function updatePIDraft(
  id: number, soId: number, updates: { mainProductPrice?: number; validityDate?: string },
): Promise<PIDraftInfo> {
  return apiFetch(`/admin/cultfit/requests/${id}/pi`, {
    method: 'PATCH',
    body: JSON.stringify({ soId, ...updates }),
  });
}

export async function publishPI(id: number, soId: number): Promise<PIPublishedSnapshot> {
  return apiFetch(`/admin/cultfit/requests/${id}/pi/publish`, {
    method: 'POST',
    body: JSON.stringify({ soId }),
  });
}

// ── Phase 3: PO workflow ──────────────────────────────────────────────────────

export async function getCustomerPoStatus(id: number): Promise<PoCustomerView> {
  return apiFetch(`/portal/cultfit/requests/${id}/po`);
}

// Multipart upload — bypasses apiFetch (which always sets
// Content-Type: application/json) since the browser must set its own
// multipart boundary header.
export async function extractPoPdf(id: number, file: File): Promise<{ extracted: ExtractedPoData }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/portal/cultfit/requests/${id}/po/extract`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError('PO_EXTRACT_FAILED', body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function submitPoData(id: number, data: PortalPoData): Promise<PoSubmitResult> {
  return apiFetch(`/portal/cultfit/requests/${id}/po/submit`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getAdminPoDetail(id: number): Promise<PoAdminView> {
  return apiFetch(`/admin/cultfit/requests/${id}/po`);
}

export async function approvePo(id: number): Promise<PoApproveResult> {
  return apiFetch(`/admin/cultfit/requests/${id}/po/approve`, { method: 'POST' });
}

export async function requestPoCorrection(id: number, comment: string): Promise<PoCorrectionResult> {
  return apiFetch(`/admin/cultfit/requests/${id}/po/request-correction`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
}
