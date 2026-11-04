import { FulfillmentStatus, PaymentStatus } from '@prisma/client';

/** Fulfillment lifecycle. COMPLETED and CANCELLED are terminal. */
const FULFILLMENT: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  PENDING_ACCEPTANCE: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Payment lifecycle. PAID can only be reached by an authenticated staff member
 * verifying the QR payment (Module 7); customers can only report a payment.
 */
const PAYMENT: Record<PaymentStatus, PaymentStatus[]> = {
  UNPAID: ['AWAITING_VERIFICATION', 'FAILED'],
  AWAITING_VERIFICATION: ['PAID', 'FAILED'],
  FAILED: ['AWAITING_VERIFICATION'], // customer can retry after staff couldn't find the payment
  PAID: ['REFUNDED'],
  REFUNDED: [],
};

export const canTransitionFulfillment = (from: FulfillmentStatus, to: FulfillmentStatus): boolean =>
  FULFILLMENT[from].includes(to);

export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus): boolean =>
  PAYMENT[from].includes(to);

/** What a customer (not staff) may do to payment status. */
export const customerCanReportPayment = (
  payment: PaymentStatus,
  fulfillment: FulfillmentStatus,
): boolean =>
  fulfillment !== 'CANCELLED' && (payment === 'UNPAID' || payment === 'FAILED');
