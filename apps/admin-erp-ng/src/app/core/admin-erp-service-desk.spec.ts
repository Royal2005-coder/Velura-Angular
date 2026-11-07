import { AdminReturnLine, AdminReturnRow, AdminTicketRow } from './admin-erp-api.service';
import { canTicketAction, contactAllowed, gatewayNote, isChatGovernedTicket, isReturnOpen, itemRefundAllowed, parseTicketBrief, refundChannelActions, refundInfoAllowed, refundReceiverBlocked, REFUND_FLOW_LABELS, RETURN_DECISION_STATUSES, RETURN_HEADER_STATUSES, returnContactOverdue, returnDecisionLabel, returnItemActions, returnStatusLabel, returnStatusTone } from './admin-erp-service-desk';

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

  it('never offers a per-part or decision code as a header status filter', () => {
    for (const notAHeaderStatus of ['RETURN_SHIPPING', 'REFUND_PENDING', 'PARTIALLY_APPROVED']) {
      expect(RETURN_HEADER_STATUSES).not.toContain(notAHeaderStatus);
    }
    expect(RETURN_HEADER_STATUSES).toContain('RETURN_IN_TRANSIT');
    expect(RETURN_HEADER_STATUSES).toContain('REFUND_PROCESSING');
    expect(RETURN_DECISION_STATUSES.map((option) => option.value)).toContain('PARTIALLY_APPROVED');
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

  it('names the VNPay/MoMo route apart from Stripe and never blames Stripe for it', () => {
    expect(REFUND_FLOW_LABELS['gateway_auto']).toBe('Hoàn tiền tự động qua cổng VNPay/MoMo');
    expect(REFUND_FLOW_LABELS['gateway_auto']).not.toBe(REFUND_FLOW_LABELS['stripe_auto']);
    for (const refund of [null, { status: 'refunded' }, { status: 'requested' }, { status: 'skipped' }, { status: 'failed' }]) {
      expect(gatewayNote(refund)).not.toContain('Stripe');
    }
    expect(gatewayNote({ status: 'failed', message: 'VNPay từ chối hoàn tiền vì ngoài thời gian cho phép' }))
      .toBe('VNPay từ chối hoàn tiền vì ngoài thời gian cho phép');
  });

  it('offers the gateway refund on every online channel and the hand transfer only after a refusal', () => {
    const stripe: AdminReturnRow = { ...base, payment_kind: 'stripe', refund_flow: 'stripe_auto' };
    const gateway: AdminReturnRow = { ...base, payment_kind: 'other_online', refund_flow: 'gateway_auto' };
    const refused = (row: AdminReturnRow): AdminReturnRow => ({ ...row, payment: { gateway_response_code: 'REFUND_FAILED' } });
    expect(refundChannelActions(null)).toEqual([]);
    expect(refundChannelActions(gateway)).toEqual(['stripe']);
    expect(refundChannelActions({ ...gateway, payment: { gateway_response_code: 'REFUND_REQUESTED' } })).toEqual(['stripe']);
    expect(refundChannelActions(refused(gateway))).toEqual(['stripe', 'manual']);
    expect(refundChannelActions(refused(stripe))).toEqual(['stripe', 'manual']);
    expect(refundChannelActions({ ...base, payment_kind: 'cod', refund_flow: 'cod_manual', refund_receiver_status: 'valid' })).toEqual(['manual']);
    expect(refundChannelActions({ ...base, payment_kind: 'cod', refund_flow: 'cod_manual', refund_receiver_status: 'missing' })).toEqual([]);
  });

  it('treats a stored manual_transfer route as an already refused gateway', () => {
    expect(refundChannelActions({ ...base, payment_kind: 'other_online', refund_flow: 'manual_transfer' })).toEqual(['stripe', 'manual']);
  });

  it('retains governed ticket transitions independently of return operations', () => {
    expect(canTicketAction(ticket('open'), 'reply')).toBe(true);
    expect(canTicketAction(ticket('open'), 'resolve')).toBe(false);
    expect(canTicketAction(ticket('processing'), 'resolve')).toBe(true);
    expect(canTicketAction(ticket('resolved'), 'reply')).toBe(false);
    expect(canTicketAction(ticket('closed'), 'close')).toBe(false);
    expect(isChatGovernedTicket(ticket('open', 'c1'))).toBe(true);
  });

  it('parses a chat handoff description into labeled facts', () => {
    const brief = parseTicketBrief(JSON.stringify({
      wanted: 'Tìm váy dự tiệc',
      problem: 'Khách muốn tìm váy dự tiệc',
      summary: 'Tìm váy dự tiệc',
      verified_status: 'member_account',
      confirmed_facts: ['Đã xác minh quyền truy cập'],
      recommendations: ['Kiểm tra đơn trước khi cam kết'],
      failed_approaches: [],
      unconfirmed_claims: ['Chưa xác minh size'],
    }));

    expect(brief?.wanted).toBe('Tìm váy dự tiệc');
    expect(brief?.verifiedStatus).toBe('member_account');
    expect(brief?.confirmedFacts).toEqual(['Đã xác minh quyền truy cập']);
    expect(brief?.unconfirmedClaims).toEqual(['Chưa xác minh size']);
  });

  it('falls back to plain text when the description is not a handoff payload', () => {
    expect(parseTicketBrief('Khách gọi đến hỏi đơn VLR-001')).toBeNull();
    expect(parseTicketBrief('{not json')).toBeNull();
    expect(parseTicketBrief(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(parseTicketBrief(null)).toBeNull();
  });
});
