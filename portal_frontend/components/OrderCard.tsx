'use client';

import Link from 'next/link';
import type { Order } from '@/types';

interface Props {
  order: Order;
  showCustomer?: boolean;
}

const STAGE_COLORS: Record<string, string> = {
  stage_1_order_received:           'bg-gray-100 text-gray-600',
  stage_2_pi_issued:                'bg-blue-100 text-blue-700',
  stage_3_po_received:              'bg-indigo-100 text-indigo-700',
  stage_4_md_approved:              'bg-purple-100 text-purple-700',
  stage_5_dispatched:               'bg-yellow-100 text-yellow-700',
  stage_6_installation_confirmed:   'bg-orange-100 text-orange-700',
  stage_7_vendor_uploaded:          'bg-teal-100 text-teal-700',
  stage_8_confirmation_sent:        'bg-cyan-100 text-cyan-700',
  stage_9_payment_collected:        'bg-green-100 text-green-700',
};

export default function OrderCard({ order, showCustomer = true }: Props) {
  const stageColor = STAGE_COLORS[order.portal_stage] ?? 'bg-gray-100 text-gray-600';

  return (
    <Link href={`/orders/${order.id}`}>
      <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-blue-300 transition-all cursor-pointer">

        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-bold text-gray-900 text-base">{order.name}</h3>
            {order.centre_name && (
              <p className="text-sm text-gray-500 mt-0.5">📍 {order.centre_name}</p>
            )}
          </div>
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${stageColor}`}>
            {order.portal_stage_label}
          </span>
        </div>

        {showCustomer && order.customer && (
          <p className="text-xs text-gray-400 mb-3">Customer: {order.customer}</p>
        )}

        {/* Key info grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">

          {/* Amount */}
          <div className="bg-gray-50 rounded-lg p-2.5">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Amount</p>
            {order.amount_total !== undefined ? (
              <p className="font-bold text-gray-900 mt-0.5">
                ₹{order.amount_total.toLocaleString('en-IN')}
              </p>
            ) : (
              <p className="text-gray-400 text-sm mt-0.5">—</p>
            )}
          </div>

          {/* Payment status */}
          <div className="bg-gray-50 rounded-lg p-2.5">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Payment</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              {order.payment_overdue ? (
                <span className="text-red-600 font-semibold text-sm">🔴 Overdue</span>
              ) : order.payment_status === 'collected' ? (
                <span className="text-green-600 font-semibold text-sm">✅ Collected</span>
              ) : order.payment_due_date ? (
                <span className="text-amber-600 font-semibold text-sm">
                  {order.days_to_payment}d left
                </span>
              ) : (
                <span className="text-gray-400 text-sm">Pending</span>
              )}
            </div>
          </div>

          {/* Installation */}
          <div className="bg-gray-50 rounded-lg p-2.5">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Installation</p>
            <p className={`text-sm font-medium mt-0.5 capitalize ${
              order.installation_status === 'confirmed' ? 'text-green-600' :
              order.installation_status === 'scheduled' ? 'text-blue-600' :
              'text-gray-400'
            }`}>
              {order.installation_status}
            </p>
          </div>

          {/* Vendor upload */}
          <div className="bg-gray-50 rounded-lg p-2.5">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Vendor Portal</p>
            <p className={`text-sm font-medium mt-0.5 ${
              order.vendor_portal_status === 'uploaded' ? 'text-green-600' : 'text-gray-400'
            }`}>
              {order.vendor_portal_status === 'uploaded' ? '✅ Uploaded' : 'Pending'}
            </p>
          </div>
        </div>

        {/* Order date */}
        {order.date_order && (
          <p className="text-xs text-gray-300 mt-3 text-right">
            Ordered: {new Date(order.date_order).toLocaleDateString('en-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          </p>
        )}
      </div>
    </Link>
  );
}
