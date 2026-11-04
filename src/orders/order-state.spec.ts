import { FulfillmentStatus, PaymentStatus } from '@prisma/client';
import {
  canTransitionFulfillment,
  canTransitionPayment,
  customerCanReportPayment,
} from './order-state';

const F: FulfillmentStatus[] = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];
const P: PaymentStatus[] = ['UNPAID', 'AWAITING_VERIFICATION', 'PAID', 'FAILED', 'REFUNDED'];

describe('fulfillment transitions', () => {
  it('follows the happy path in order', () => {
    expect(canTransitionFulfillment('PENDING_ACCEPTANCE', 'ACCEPTED')).toBe(true);
    expect(canTransitionFulfillment('ACCEPTED', 'PREPARING')).toBe(true);
    expect(canTransitionFulfillment('PREPARING', 'READY')).toBe(true);
    expect(canTransitionFulfillment('READY', 'COMPLETED')).toBe(true);
  });
  it('does not allow skipping steps or going backwards', () => {
    expect(canTransitionFulfillment('PENDING_ACCEPTANCE', 'READY')).toBe(false);
    expect(canTransitionFulfillment('PENDING_ACCEPTANCE', 'COMPLETED')).toBe(false);
    expect(canTransitionFulfillment('READY', 'PREPARING')).toBe(false);
  });
  it('treats COMPLETED and CANCELLED as terminal', () => {
    for (const to of F) {
      expect(canTransitionFulfillment('COMPLETED', to)).toBe(false);
      expect(canTransitionFulfillment('CANCELLED', to)).toBe(false);
    }
  });
  it('never transitions to itself', () => {
    for (const s of F) expect(canTransitionFulfillment(s, s)).toBe(false);
  });
});

describe('payment transitions', () => {
  it('only goes UNPAID -> AWAITING_VERIFICATION -> PAID', () => {
    expect(canTransitionPayment('UNPAID', 'PAID')).toBe(false); // can't skip verification
    expect(canTransitionPayment('UNPAID', 'AWAITING_VERIFICATION')).toBe(true);
    expect(canTransitionPayment('AWAITING_VERIFICATION', 'PAID')).toBe(true);
  });
  it('allows refund only from PAID', () => {
    for (const s of P) expect(canTransitionPayment(s, 'REFUNDED')).toBe(s === 'PAID');
  });
  it('a failed payment never becomes PAID directly', () => {
    expect(canTransitionPayment('FAILED', 'PAID')).toBe(false);
  });
});

describe('customerCanReportPayment', () => {
  it('allows unpaid/failed orders that are not cancelled', () => {
    expect(customerCanReportPayment('UNPAID', 'PENDING_ACCEPTANCE')).toBe(true);
    expect(customerCanReportPayment('FAILED', 'PENDING_ACCEPTANCE')).toBe(true);
  });
  it('blocks cancelled, already-reported and paid orders', () => {
    expect(customerCanReportPayment('UNPAID', 'CANCELLED')).toBe(false);
    expect(customerCanReportPayment('AWAITING_VERIFICATION', 'PENDING_ACCEPTANCE')).toBe(false);
    expect(customerCanReportPayment('PAID', 'PREPARING')).toBe(false);
  });
});
