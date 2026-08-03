'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCultFitProducts, submitOrderRequest } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import PortalHeader from '@/components/PortalHeader';
import type { CultFitProductOption } from '@/types';

// Contact details (name/phone/email) are deliberately NOT collected here —
// the CultFit customer/contact already exists in Odoo, resolved server-side
// on submit. See CULTFIT_PORTAL_MASTER_CONTEXT.md §9.
interface FormState {
  requestName: string;
  cocoFofo: '' | 'COCO' | 'FOFO';
  mainProductId: string;
  quantity: string;
  deliveryAddress: string;
  preferredDeliveryDate: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  requestName: '', cocoFofo: '', mainProductId: '', quantity: '1',
  deliveryAddress: '', preferredDeliveryDate: '', notes: '',
};

export default function NewOrderRequestPage() {
  const router = useRouter();
  const [userName, setUserName] = useState('');

  const [products, setProducts] = useState<CultFitProductOption[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (isInBodyStaff(u.role)) { router.replace('/admin'); return; }
      setUserName(u.name ?? '');
    });
  }, [router]);

  useEffect(() => {
    getCultFitProducts()
      .then(res => setProducts(res.products))
      .catch(err => setProductsError(err instanceof Error ? err.message : 'Failed to load products.'))
      .finally(() => setProductsLoading(false));
  }, []);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!form.requestName.trim()) errs.requestName = 'Required';
    if (!form.cocoFofo) errs.cocoFofo = 'Required';
    if (!form.mainProductId) errs.mainProductId = 'Required';
    const qty = Number(form.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) errs.quantity = 'Enter a whole number between 1 and 999';
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // guards against double-submit (e.g. double-click / double Enter)
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await submitOrderRequest({
        requestName: form.requestName.trim(),
        cocoFofo: form.cocoFofo as 'COCO' | 'FOFO',
        mainProductId: Number(form.mainProductId),
        quantity: Number(form.quantity),
        deliveryAddress: form.deliveryAddress.trim(),
        preferredDeliveryDate: form.preferredDeliveryDate || undefined,
        notes: form.notes.trim() || undefined,
      });
      router.push(`/requests/${result.id}`);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit request.');
      setSubmitting(false);
    }
  }

  const selectedProduct = products.find(p => String(p.id) === form.mainProductId);
  const bundleNote = selectedProduct?.hasBundle
    ? 'This model includes matching accessories/software at no extra cost — InBody will confirm exact items with your PI.'
    : null;

  const inputCls = (hasError: boolean) =>
    `w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 ${
      hasError ? 'border-red-300 focus:ring-red-400' : 'border-slate-300 focus:ring-blue-500'
    }`;

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CUSTOMER" userName={userName} onLogout={handleLogout} />

      <div className="max-w-screen-md mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">New Order Request</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Submit a new machine requirement. InBody will review it and follow up with a Proforma Invoice.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5">

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">
              Request / Location Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.requestName}
              onChange={e => set('requestName', e.target.value)}
              placeholder="e.g. Cult Andheri West"
              maxLength={120}
              className={inputCls(!!fieldErrors.requestName)}
            />
            {fieldErrors.requestName && <p className="text-xs text-red-600 mt-1">{fieldErrors.requestName}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">
                COCO or FOFO <span className="text-red-500">*</span>
              </label>
              <select
                value={form.cocoFofo}
                onChange={e => set('cocoFofo', e.target.value as FormState['cocoFofo'])}
                className={inputCls(!!fieldErrors.cocoFofo) + ' bg-white'}
              >
                <option value="">Select...</option>
                <option value="COCO">COCO</option>
                <option value="FOFO">FOFO</option>
              </select>
              {fieldErrors.cocoFofo && <p className="text-xs text-red-600 mt-1">{fieldErrors.cocoFofo}</p>}
            </div>

            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">
                Quantity <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min={1}
                max={999}
                value={form.quantity}
                onChange={e => set('quantity', e.target.value)}
                className={inputCls(!!fieldErrors.quantity)}
              />
              {fieldErrors.quantity && <p className="text-xs text-red-600 mt-1">{fieldErrors.quantity}</p>}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">
              Main Product <span className="text-red-500">*</span>
            </label>
            {productsLoading ? (
              <p className="text-sm text-slate-400">Loading products...</p>
            ) : productsError ? (
              <p className="text-sm text-red-600">{productsError}</p>
            ) : (
              <select
                value={form.mainProductId}
                onChange={e => set('mainProductId', e.target.value)}
                className={inputCls(!!fieldErrors.mainProductId) + ' bg-white'}
              >
                <option value="">Select a product...</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.code ? `[${p.code}] ${p.name}` : p.name}</option>
                ))}
              </select>
            )}
            {fieldErrors.mainProductId && <p className="text-xs text-red-600 mt-1">{fieldErrors.mainProductId}</p>}
            {bundleNote && (
              <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 mt-2">{bundleNote}</p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">
              Delivery Address
            </label>
            <textarea
              rows={2}
              value={form.deliveryAddress}
              onChange={e => set('deliveryAddress', e.target.value)}
              maxLength={300}
              className={inputCls(!!fieldErrors.deliveryAddress) + ' resize-none'}
            />
            {fieldErrors.deliveryAddress && <p className="text-xs text-red-600 mt-1">{fieldErrors.deliveryAddress}</p>}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Preferred Delivery Date</label>
            <input
              type="date"
              value={form.preferredDeliveryDate}
              onChange={e => set('preferredDeliveryDate', e.target.value)}
              className={inputCls(false) + ' sm:w-1/2'}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              maxLength={1000}
              placeholder="Anything else InBody should know about this request"
              className={inputCls(false) + ' resize-none'}
            />
          </div>

          {submitError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || productsLoading}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
            <button
              type="button"
              onClick={() => router.push('/requests')}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
