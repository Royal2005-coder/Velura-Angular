import { AdminOrderAction, AdminOrderEvent, AdminOrderRow } from './admin-erp-api.service';
import {
  actionPrefill,
  auditTrace,
  eventTrace,
  handoverFollowUp,
  handoverNote,
  mergeOrderTrace,
  returnTrace,
} from './admin-erp-order-trace';

const shipmentAction: AdminOrderAction = {
  code: 'upsert_shipment',
  label: 'Tạo/cập nhật vận đơn',
  to_status: null,
  requires_note: true,
  fields: ['shipment'],
  destructive: false,
};

const handoverAction: AdminOrderAction = {
  code: 'confirm_handover',
  label: 'Xác nhận bàn giao ĐVVC',
  to_status: 'shipping',
  requires_note: true,
  fields: [],
  destructive: false,
};

function order(overrides: Partial<AdminOrderRow> = {}): AdminOrderRow {
  return {
    order_id: '11111111-2222-3333-4444-555555555555',
    order_code: 'VLR-1001',
    status: 'processing',
    carrier: 'GHN',
    tracking_code: 'VN2200111',
    tracking_url: 'https://tracking.example/VN2200111',
    version: 4,
    allowed_actions: [shipmentAction, handoverAction],
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<AdminOrderEvent> = {}): AdminOrderEvent {
  return {
    event_id: 'e-1',
    action: 'upsert_shipment',
    actor_type: 'manual',
    actor_role: 'admin_operator_donhang',
    created_at: '2026-10-20T03:00:00Z',
    ...overrides,
  };
}

describe('admin order trace', () => {
  it('turns a state-machine event into one labelled trail row with its payload facts', () => {
    const [entry] = eventTrace([event({ payload: { carrier: 'GHN', tracking_code: 'VN2200111' } })]);
    expect(entry.title).toBe('Tạo/cập nhật vận đơn');
    expect(entry.actor).toBe('admin_operator_donhang');
    expect(entry.detail).toContain('VN2200111');
    expect(entry.origin).toBe('order');
  });

  it('separates system and customer actors', () => {
    expect(eventTrace([event({ actor_type: 'system' })])[0].actor).toBe('Hệ thống');
    expect(eventTrace([event({ actor_type: 'customer' })])[0].actor).toBe('Khách hàng');
  });

  it('folds the audit twin of a manual action into the event and keeps the actor name', () => {
    const merged = mergeOrderTrace(
      eventTrace([event()]),
      auditTrace([
        {
          audit_id: 'a-1',
          timestamp: '2026-10-20T03:00:01Z',
          actor_label: 'Nguyễn Quản Lý',
          module: 'orders',
          action: 'update',
          new_value: { action: 'upsert_shipment' },
        },
      ]),
    );
    expect(merged.length).toBe(1);
    expect(merged[0].actor).toBe('Nguyễn Quản Lý');
  });

  it('keeps audit rows that describe a different fact', () => {
    const merged = mergeOrderTrace(
      eventTrace([event()]),
      auditTrace([{ audit_id: 'a-2', timestamp: '2026-10-21T09:00:00Z', action: 'update', new_value: { status: 'processing' } }]),
    );
    expect(merged.length).toBe(2);
  });

  it('sorts the merged trail newest first and drops rows without a timestamp', () => {
    const merged = mergeOrderTrace(eventTrace([event({ event_id: 'e-old', created_at: '2026-10-19T01:00:00Z' })]), eventTrace([event({ event_id: 'e-new', created_at: '2026-10-21T01:00:00Z' })]), eventTrace([event({ event_id: 'e-none', created_at: undefined })]));
    expect(merged.map((entry) => entry.id)).toEqual(['event:e-new', 'event:e-old']);
  });

  it('prefills shipment facts and a drafted note', () => {
    const prefill = actionPrefill(shipmentAction, order());
    expect(prefill.carrier).toBe('GHN');
    expect(prefill.trackingCode).toBe('VN2200111');
    expect(prefill.trackingUrl).toBe('https://tracking.example/VN2200111');
    expect(prefill.note).toContain('VLR-1001');
  });

  it('does not leak shipment facts into actions that do not carry them', () => {
    const prefill = actionPrefill({ ...shipmentAction, code: 'start_processing', fields: [] }, order());
    expect(prefill.carrier).toBe('');
    expect(prefill.trackingCode).toBe('');
    expect(prefill.note).toBe('Bắt đầu chuẩn bị hàng đơn VLR-1001');
  });

  it('quotes the carrier reason of the last failed delivery when logging one', () => {
    const failed = event({
      event_id: 'e-fail',
      action: 'carrier_failed_returned',
      created_at: '2026-10-22T05:00:00Z',
      note: 'Khách không nhận hàng',
      payload: { reason: 'Không liên hệ được người nhận' },
    });
    const prefill = actionPrefill({ ...shipmentAction, code: 'record_failure_reason', fields: [] }, order({ events: [failed] }));
    expect(prefill.note).toContain('Không liên hệ được người nhận');
  });

  it('only offers the chained handover while the parcel is still awaiting handover', () => {
    expect(handoverFollowUp(order(), { carrier: 'GHN', trackingCode: 'VN2200111' })).toEqual(handoverAction);
    expect(handoverFollowUp(order({ status: 'shipping' }), { carrier: 'GHN', trackingCode: 'VN2200111' })).toBeNull();
    expect(handoverFollowUp(order({ shipment_voided_at: '2026-10-20T04:00:00Z' }), { carrier: 'GHN', trackingCode: 'VN2200111' })).toBeNull();
    expect(handoverFollowUp(order(), { carrier: 'GHN', trackingCode: '  ' })).toBeNull();
    expect(handoverFollowUp(order({ allowed_actions: [shipmentAction] }), { carrier: 'GHN', trackingCode: 'VN2200111' })).toBeNull();
  });

  it('writes a handover note naming the tracking it just stored', () => {
    expect(handoverNote('GHN', 'VN2200111', 'VLR-1001')).toContain('VN2200111');
  });

  it('links a return record back to its own file and to the replacement order', () => {
    const [entry] = returnTrace([
      {
        return_id: 'r-1',
        order_id: 'o-1',
        status: 'RECEIVED',
        created_at: '2026-10-23T02:00:00Z',
        exchange_order_id: 'o-9',
        refund_amount: 350000,
      },
    ]);
    expect(entry.origin).toBe('return');
    expect(entry.title).toContain('Kho đã nhận');
    expect(entry.links.map((link) => link.query)).toEqual([{ focus: 'r-1' }, { focus: 'o-9' }]);
  });
});
