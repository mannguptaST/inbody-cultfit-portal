import { NextResponse } from 'next/server';
import { checkOdooHealth } from '@/lib/odoo-server';

// Intentionally reveals nothing beyond ok/degraded — no Odoo URL, DB name,
// or credentials, even when Odoo is unreachable.
export async function GET() {
  const odooOk = await checkOdooHealth();
  return NextResponse.json(
    {
      status: odooOk ? 'ok' : 'degraded',
      application: 'inbody-cultfit-portal',
      odoo: odooOk ? 'connected' : 'unreachable',
    },
    { status: odooOk ? 200 : 503 },
  );
}
