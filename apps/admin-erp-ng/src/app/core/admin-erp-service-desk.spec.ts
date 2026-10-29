import { AdminReturnLine, AdminReturnRow, AdminTicketRow } from './admin-erp-api.service';
import { canTicketAction, contactAllowed, isChatGovernedTicket, isReturnOpen, itemRefundAllowed, refundInfoAllowed, refundReceiverBlocked, returnContactOverdue, returnDecisionLabel, returnItemActions, returnStatusLabel, returnStatusTone } from './admin-erp-service-desk';

const base: AdminReturnRow = { return_id: 'r1', order_id: 'o1', return_type: 'exchange', status: 'IN_PROGRESS', version: 1 };
const part: AdminReturnLine = { return_item_id: 'part1', quantity: 2, version: 1, decision_status: 'approved', resolution_type: 'exchange', item_status: 'RECEIVED' };
const ticket = (status: string, chatSessionId: string | null = null): AdminTicketRow => ({ ticket_id: 't1', status, chat_session_id: chatSessionId, version: 1 });

describe('service desk per-part rules', () => {
  it('keeps aggregate decisions separate from mixed processing stages', () => {
    expect(returnStatusLabel('IN_PROGRESS')).toBe('Đang xử lý từng phần');
    expect(returnDecisionLabel('PARTIALLY_APPROVED')).toBe('Duyệt một phần');
    expect(returnStatusLabel('REJECTED')).toBe('Đã từ chối');
    expect(returnStatusTone('REJECTED')).toBe('danger');
    expect(isReturnOpen('IN_PROGRESS')).toBe(true); expect(isReturnOpen('REJECTED')).toBe(false);
  });

  it('offers final decisions to super-admin only while the item is undecided', () => {
    const pending = { ...part, decision_status: 'pending' as const, item_status: 'REQUESTED' };
    expect(returnItemActions(pending, false)).toEqual([]);
    expect(returnItemActions(pending, true)).toEqual(['approve', 'reject']);
    expect(returnItemActions(part, true)).not.toContain('reject');
  });

  it('requires recorded handover before warehouse receipt and prevents post-handover stop', () => {
    const waiting = returnItemActions({ ...part, item_status: 'WAITING_RETURN' }, false);
    expect(waiting).toContain('pickup'); expect(waiting).not.toContain('receive'); expect(waiting).toContain('stop');
    const shipping = returnItemActions({ ...part, item_status: 'RETURN_SHIPPING' }, false);
    expect(shipping).toContain('receive'); expect(shipping).not.toContain('stop');
    expect(returnItemActions({ ...part, item_status: 'RECEIVED' }, false)).not.toContain('stop');
  });

  it('drives logistics and money from each resolution, never the immutable request type', () => {
    expect(returnItemActions(part, false)).toContain('prepare_exchange');
    expect(itemRefundAllowed(part)).toBe(false);
    const converted = { ...part, resolution_type: 'refund' as const };
    expect(itemRefundAllowed(converted)).toBe(true);
    expect(returnItemActions(converted, false)).not.toContain('prepare_exchange');
    expect(itemRefundAllowed({ ...converted, item_status: 'RETURN_SHIPPING' })).toBe(false);
    expect(itemRefundAllowed({ ...converted, item_status: 'COMPLETED' })).toBe(false);
  });

  it('removes operations from terminal parts and blocks variant changes once an exchange order exists', () => {
    expect(returnItemActions({ ...part, item_status: 'REJECTED' }, true)).toEqual([]);
    const linked = returnItemActions({ ...part, exchange_order_id: 'replacement1', exchange_order: { status: 'confirmed' }, item_status: 'EXCHANGE_PREPARING' }, false);
    expect(linked).toContain('ship_exchange'); expect(linked).not.toContain('change_variant'); expect(linked).toContain('convert_refund');
    expect(returnItemActions({ ...part, item_status: 'EXCHANGE_SHIPPING', exchange_order: { status: 'shipping' } }, false)).not.toContain('complete_exchange');
    expect(returnItemActions({ ...part, item_status: 'EXCHANGE_SHIPPING', exchange_order: { status: 'delivered' } }, false)).toContain('complete_exchange');
  });

  it('retains contact SLA and customer-attention independently of processing progress', () => {
    const waiting = { ...base, attention_status: 'waiting_customer', contact_due_at: '2026-10-28T12:00:00Z' };
    expect(returnContactOverdue(waiting, Date.parse('2026-10-29T12:00:00Z'))).toBe(true);
    expect(returnContactOverdue({ ...waiting, contact_due_at: null })).toBe(false);
    expect(returnContactOverdue({ ...waiting, status: 'REJECTED' })).toBe(false);
    expect(contactAllowed(waiting)).toBe(true);
  });

  it('collects COD bank details even for an exchange request with one converted refund part', () => {
    expect(refundInfoAllowed({ ...base, payment_kind: 'cod' })).toBe(true);
    expect(refundInfoAllowed({ ...base, payment_kind: 'stripe' })).toBe(false);
    expect(refundReceiverBlocked({ ...base, payment_kind: 'cod', refund_flow: 'cod_manual', refund_receiver_status: 'missing' })).toBe(true);
    expect(refundReceiverBlocked({ ...base, payment_kind: 'cod', refund_flow: 'cod_manual', refund_receiver_status: 'valid' })).toBe(false);
  });

  it('retains governed ticket transitions independently of return operations', () => {
    expect(canTicketAction(ticket('open'), 'reply')).toBe(true);
    expect(canTicketAction(ticket('open'), 'resolve')).toBe(false);
    expect(canTicketAction(ticket('processing'), 'resolve')).toBe(true);
    expect(canTicketAction(ticket('resolved'), 'reply')).toBe(false);
    expect(canTicketAction(ticket('closed'), 'close')).toBe(false);
    expect(isChatGovernedTicket(ticket('open', 'c1'))).toBe(true);
  });
});
