import { NextRequest, NextResponse } from 'next/server';
import { requireAuthUser } from '@/lib/auth-server';
import {
  extractPoPdf, LeadNotFoundError, PartnerNotMappedError, PoWorkflowError, type Authz,
} from '@/lib/odoo-server';
import { InvalidPdfError, EncryptedPdfError, PdfTooLargeError, MAX_PO_PDF_BYTES } from '@/lib/po-pdf-parser';
import { checkMultipartMutation } from '@/lib/route-security';

// Step A of the two-step PO flow — extraction only, no Odoo write. The PDF
// is read into a Buffer for this request's lifetime only: never written to
// disk, Odoo, or any store, never logged. Its bytes go out of scope (and are
// GC-eligible) the moment this handler returns.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = requireAuthUser(req);
  if (!user) return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'customer') return NextResponse.json({ detail: 'Customer access required' }, { status: 403 });

  const rejection = checkMultipartMutation(req);
  if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });

  const { id } = await params;
  const requestId = parseInt(id, 10);
  if (isNaN(requestId)) return NextResponse.json({ detail: 'Invalid request ID' }, { status: 400 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ detail: 'Could not read upload.' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: 'No file uploaded.' }, { status: 400 });
  }
  if (file.type && file.type !== 'application/pdf') {
    return NextResponse.json({ detail: 'Only PDF files are accepted.' }, { status: 400 });
  }
  if (file.size > MAX_PO_PDF_BYTES) {
    return NextResponse.json({ detail: `PDF exceeds the ${MAX_PO_PDF_BYTES / (1024 * 1024)}MB upload limit.` }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ detail: 'Could not read the uploaded file.' }, { status: 400 });
  }

  try {
    const authz: Authz = { role: 'customer', scope: user.scope };
    const extracted = await extractPoPdf(requestId, buffer, file.name, authz);
    return NextResponse.json({ extracted });
  } catch (e: unknown) {
    if (e instanceof InvalidPdfError || e instanceof EncryptedPdfError || e instanceof PdfTooLargeError) {
      return NextResponse.json({ detail: e.message }, { status: 400 });
    }
    if (e instanceof PoWorkflowError) return NextResponse.json({ detail: e.message }, { status: 400 });
    if (e instanceof LeadNotFoundError) return NextResponse.json({ detail: e.message }, { status: 404 });
    if (e instanceof PartnerNotMappedError) return NextResponse.json({ detail: e.message }, { status: 403 });
    // Deliberately generic — never echoes parser internals or PDF content.
    console.error('[po extract] failed for request', requestId, e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ detail: 'Could not extract PO details. Please try again later.' }, { status: 503 });
  }
}
