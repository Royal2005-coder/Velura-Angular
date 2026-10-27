import { AdminReturnRow, AdminTicketRow } from './admin-erp-api.service';
import {
  allowedReturnTransitions,
  canTicketAction,
  contactAllowed,
  exchangeApprovalAllowed,
  gatewayRefundAllowed,
  isChatGovernedTicket,
  isReturnOpen,
  manualReturnTransitions,
  receiptAllowed,
  refundInfoAllowed,
  refundReceiverBlocked,
  rejectAllowed,
  returnStatusLabel,
  returnStatusTone,
  stripeRefundAllowed,
  manualRefundAllowed,
  nextReturnStep,
  warehouseQaPassed,
} from './admin-erp-service-desk';

const base: AdminReturnRow = { return_id: 'r1', order_id: 'o1', return_type: 'refund', status: 'REQUESTED', version: 1 };

const ticket = (status: string, chatSessionId: string | null = null): AdminTicketRow => ({
  ticket_id: 't1',
  status,
  chat_session_id: chatSessionId,
  version: 1,
});

describe('service desk rules mirrored from the API', () => {
  it('keeps the return state machine identical to RETURN_TRANSITIONS', () => {
    expect(allowedReturnTransitions('REQUESTED')).toEqual(['CONTACTING', 'CANCELLED']);
    expect(allowedReturnTransitions('RETURN_IN_TRANSIT')).toEqual(['RECEIVED', 'NEEDS_SUPPORT']);
    expect(allowedReturnTransitions('COMPLETED')).toEqual([]);
    expect(allowedReturnTransitions('unknown')).toEqual([]);
    expect(returnStatusLabel('NEEDS_SUPPORT')).toBeTruthy();
    expect(returnStatusTone('NEEDS_SUPPORT')).toBe('danger');
  });

  it('never offers the two gateway-owned states as manual steps', () => {
    expect(manualReturnTransitions('RECEIVED')).toEqual(['EXCHANGE_PREPARING', 'NEEDS_SUPPORT']);
    expect(manualReturnTransitions('REFUNDED')).toEqual(['COMPLETED']);
  });

  it('only allows exchange preparation after the warehouse QA passed', () => {
    const received: AdminReturnRow = { ...base, status: 'RECEIVED', condition_check_result: 'qa_pass' };
    expect(warehouseQaPassed(received)).toBe(true);
    expect(exchangeApprovalAllowed({ ...received, return_type: 'exchange' })).toBe(true);
    expect(exchangeApprovalAllowed(received)).toBe(false);
    expect(exchangeApprovalAllowed(base)).toBe(false);
    expect(exchangeApprovalAllowed({ ...received, condition_check_result: undefined })).toBe(false);
    expect(exchangeApprovalAllowed(null)).toBe(false);
  });

  it('points at the next legal step and never at money before QA', () => {
    expect(nextReturnStep({ ...base, status: 'REQUESTED' })?.flow).toBe('contact');
    expect(nextReturnStep({ ...base, status: 'WAITING_RETURN' })?.flow).toBe('shipment');
    expect(nextReturnStep({
      ...base,
      status: 'WAITING_RETURN',
      shipment: { status: 'label_ready', carrier: 'GHN', tracking_code: 'GHN123456' },
    })?.flow).toBe('pickup');
    expect(nextReturnStep({ ...base, status: 'RETURN_IN_TRANSIT' })?.flow).toBe('receipt');
    expect(nextReturnStep({ ...base, status: 'EXCHANGE_PREPARING', return_type: 'exchange' })?.flow).toBe('exchange-shipment');
    expect(nextReturnStep({ ...base, status: 'RECEIVED', condition_check_result: 'qa_pass' })?.flow).toBe('gateway');
    expect(
      nextReturnStep({ ...base, status: 'RECEIVED', condition_check_result: 'qa_pass', return_type: 'exchange' })?.flow,
    ).toBe('exchange');
    expect(
      nextReturnStep({
        ...base,
        status: 'RECEIVED',
        condition_check_result: 'qa_pass',
        refund_flow: 'cod_manual',
        refund_receiver_status: 'missing',
      })?.flow,
    ).toBe('refund-info');
    expect(
      nextReturnStep({
        ...base,
        status: 'RECEIVED',
        condition_check_result: 'qa_pass',
        refund_flow: 'cod_manual',
        refund_receiver_status: 'valid',
      })?.flow,
    ).toBe('gateway');
    expect(nextReturnStep({ ...base, status: 'REFUNDED' })?.target).toBe('COMPLETED');
    expect(nextReturnStep({ ...base, status: 'CANCELLED' })).toBeNull();
  });

  it('hides the exchange preparation step on a refund slip', () => {
    expect(manualReturnTransitions('RECEIVED', 'refund')).toEqual(['NEEDS_SUPPORT']);
    expect(manualReturnTransitions('RECEIVED', 'exchange')).toEqual(['EXCHANGE_PREPARING', 'NEEDS_SUPPORT']);
  });

  it('gates refunds on the warehouse receipt and the payment channel', () => {
    const received = { ...base, status: 'RECEIVED', condition_check_result: 'qa_pass', payment_kind: 'stripe' as const };
    expect(gatewayRefundAllowed(received)).toBe(true);
    expect(stripeRefundAllowed(received)).toBe(true);
    expect(manualRefundAllowed(received)).toBe(false);
    expect(
      manualRefundAllowed({
        ...received,
        payment_kind: 'other_online',
        refund_flow: 'manual_transfer',
        payment: { payment_status: 'paid' },
      }),
    ).toBe(true);
    expect(gatewayRefundAllowed({ ...base, status: 'RECEIVED', condition_check_result: 'qa_fail' })).toBe(false);
  });

  it('keeps outreach, rejection and receipt on their legal states', () => {
    expect(contactAllowed(base)).toBe(true);
    expect(contactAllowed({ ...base, status: 'COMPLETED' })).toBe(false);
    expect(rejectAllowed({ ...base, status: 'NEEDS_SUPPORT' })).toBe(true);
    expect(rejectAllowed({ ...base, status: 'RETURN_IN_TRANSIT' })).toBe(false);
    expect(receiptAllowed({ ...base, status: 'RETURN_IN_TRANSIT' })).toBe(true);
    expect(receiptAllowed({ ...base, status: 'RECEIVED' })).toBe(false);
    expect(isReturnOpen('REQUESTED')).toBe(true);
    expect(isReturnOpen('CANCELLED')).toBe(false);
  });

  it('offers the payout supplement only for a live COD refund', () => {
    expect(refundInfoAllowed({ ...base, refund_flow: 'cod_manual' })).toBe(true);
    expect(refundInfoAllowed({ ...base, refund_flow: 'stripe_auto' })).toBe(false);
    expect(refundInfoAllowed({ ...base, refund_flow: 'cod_manual', status: 'COMPLETED' })).toBe(false);
    expect(refundReceiverBlocked({ ...base, refund_flow: 'cod_manual', refund_receiver_status: 'missing' })).toBe(true);
    expect(refundReceiverBlocked({ ...base, refund_flow: 'cod_manual', refund_receiver_status: 'valid' })).toBe(false);
  });

  it('follows SUPPORT_TICKET_TRANSITIONS and blocks chat-governed tickets', () => {
    expect(canTicketAction(ticket('open'), 'reply')).toBe(true);
    expect(canTicketAction(ticket('open'), 'resolve')).toBe(false);
    expect(canTicketAction(ticket('processing'), 'resolve')).toBe(true);
    expect(canTicketAction(ticket('resolved'), 'reply')).toBe(false);
    expect(canTicketAction(ticket('closed'), 'close')).toBe(false);
    expect(isChatGovernedTicket(ticket('open', 'c1'))).toBe(true);
    expect(isChatGovernedTicket(ticket('open'))).toBe(false);
  });
});
