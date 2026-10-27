import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  AdminErpApiService,
  AdminManualRefundInput,
  AdminReturnRow,
  AdminReturnStatusInput,
} from '../../core/admin-erp-api.service';
import { ReturnFlowComponent } from './return-flow.component';

const pending: AdminReturnRow = {
  return_id: 'r1',
  order_id: 'o1',
  return_type: 'refund',
  status: 'REQUESTED',
  version: 3,
  refundable_amount: 500_000,
  payment_kind: 'cod',
  refund_flow: 'cod_manual',
  refund_receiver_status: 'missing',
};

const qaPassed: AdminReturnRow = {
  ...pending,
  status: 'RECEIVED',
  condition_check_result: 'qa_pass',
  refund_receiver_status: 'valid',
};

const transit: AdminReturnRow = {
  ...pending,
  status: 'RETURN_IN_TRANSIT',
  version: 2,
  lines: [
    { order_item_id: 'i-1', quantity: 2 },
    { order_item_id: 'i-2', quantity: 1 },
  ],
};

const input = (value: string): Event => ({ target: { value } }) as unknown as Event;

describe('ReturnFlowComponent', () => {
  function boot(api: Partial<AdminErpApiService>, record: AdminReturnRow, flow: string | null, preset = '') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReturnFlowComponent],
      providers: [{ provide: AdminErpApiService, useValue: api }],
    });
    const fixture = TestBed.createComponent(ReturnFlowComponent);
    fixture.componentRef.setInput('record', record);
    fixture.componentRef.setInput('flow', flow);
    fixture.componentRef.setInput('presetStatus', preset);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('prefills the exact refundable amount and a local transfer instant when the manual modal opens', () => {
    const flow$ = boot({}, qaPassed, 'manual');

    expect(flow$.amount()).toBe(500_000);
    expect(flow$.amountMismatch()).toBe(false);
    expect(flow$.transferredAt()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    flow$.setAmount(input('700000'));
    expect(flow$.amountMismatch()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);

    flow$.setAmount(input('400000'));
    expect(flow$.amountMismatch()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);

    flow$.setAmount(input('500000'));
    flow$.setText('transferReference', input('FT2409012345'));
    flow$.proof.set('data:image/jpeg;base64,AAA');
    expect(flow$.canSubmit()).toBe(true);
  });

  it('blocks the manual transfer until the COD receiver is valid', () => {
    const flow$ = boot({}, { ...qaPassed, refund_receiver_status: 'missing' }, 'manual');
    flow$.setText('transferReference', input('FT2409012345'));
    flow$.proof.set('data:image/jpeg;base64,AAA');

    expect(flow$.blockedByReceiver()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);
  });

  it('seeds every warehouse receipt line so the operator can confirm the receipt', () => {
    const calls: AdminReturnStatusInput[] = [];
    const flow$ = boot(
      {
        updateReturnStatus: (_id, body) => {
          calls.push(body);
          return of(transit);
        },
      },
      transit,
      'receipt',
    );

    expect(flow$.canSubmit()).toBe(false);

    flow$.proof.set('https://cdn.velura.test/qa.jpg');
    flow$.setReceipt('i-2', 'received', input('3'));
    expect(flow$.canSubmit()).toBe(false);

    flow$.setReceipt('i-2', 'received', input('1'));
    flow$.submit();

    expect(calls.length).toBe(1);
    const body = calls[0];
    expect(body.status).toBe('RECEIVED');
    expect(body.conditionCheckResult).toBe('qa_pass');
    expect(body.expectedVersion).toBe(2);
    // the API stores and re-reads these keys verbatim, so they stay camelCase
    expect(body.items).toEqual([
      { orderItemId: 'i-1', receivedQuantity: 2, matchesProduct: true, disposition: 'restock' },
      { orderItemId: 'i-2', receivedQuantity: 1, matchesProduct: true, disposition: 'restock' },
    ]);
  });

  it('prepares an exchange through EXCHANGE_PREPARING instead of the legacy approval endpoint', () => {
    const calls: AdminReturnStatusInput[] = [];
    const exchange: AdminReturnRow = { ...qaPassed, return_type: 'exchange' };
    const flow$ = boot(
      {
        updateReturnStatus: (_id, body) => {
          calls.push(body);
          return of(exchange);
        },
      },
      exchange,
      'exchange',
    );

    expect(flow$.canSubmit()).toBe(true);
    flow$.submit();

    expect(calls[0]).toEqual({ status: 'EXCHANGE_PREPARING', expectedVersion: 3 });
  });

  it('creates the inbound return shipment with the carrier AWB and derived tracking URL', () => {
    const sent: Array<Record<string, unknown>> = [];
    const waiting: AdminReturnRow = { ...pending, status: 'WAITING_RETURN' };
    const flow$ = boot(
      {
        createReturnShipment: (_id, body) => {
          sent.push(body as unknown as Record<string, unknown>);
          return of({ return: waiting, shipment: { shipment_id: 's1', status: 'label_ready' } });
        },
      },
      waiting,
      'shipment',
    );

    flow$.setShipmentField('trackingCode', input('GHN123456789'));
    expect(flow$.canSubmit()).toBe(true);
    flow$.submit();

    expect(sent[0]).toEqual({
      expectedVersion: 3,
      carrier: 'GHN',
      trackingCode: 'GHN123456789',
      trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN123456789',
    });
  });

  it('uploads pickup evidence before confirming the carrier handover', () => {
    const uploads: string[] = [];
    const confirmed: Array<Record<string, unknown>> = [];
    const waiting: AdminReturnRow = {
      ...pending,
      status: 'WAITING_RETURN',
      shipment: { status: 'label_ready', carrier: 'GHN', tracking_code: 'GHN123456789', shipment_id: 's1' },
    };
    const flow$ = boot(
      {
        uploadReturnEvidence: (_id, file, kind) => {
          uploads.push(`${kind}:${file.name}`);
          return of({ evidence_id: 'e1', storage_ref: 'storage://return-evidence-private/returns/r1/pickup/a.jpg' });
        },
        confirmReturnPickup: (_id, body) => {
          confirmed.push(body as unknown as Record<string, unknown>);
          return of({ return: waiting, shipment: { shipment_id: 's1', status: 'picked_up' } });
        },
      },
      waiting,
      'pickup',
    );

    flow$.pickupPhotos.set([{ name: 'sealed.jpg', type: 'image/jpeg' } as File]);
    expect(flow$.canSubmit()).toBe(false);
    flow$.applyPickupScan('GHN123456789');
    expect(flow$.canSubmit()).toBe(true);
    flow$.submit();

    expect(uploads).toEqual(['pickup_photo:sealed.jpg']);
    expect(confirmed[0]).toEqual({
      expectedVersion: 3,
      photoUrls: ['storage://return-evidence-private/returns/r1/pickup/a.jpg'],
    });
  });

  it('requires a ten-character reason for rejection and outreach', () => {
    const rejected = boot({}, pending, 'reject');
    rejected.setNote(input('ngắn'));
    expect(rejected.canSubmit()).toBe(false);
    rejected.setNote(input('Sản phẩm còn hạn bảo hành, khách đổi ý nên từ chối.'));
    expect(rejected.canSubmit()).toBe(true);

    const contact = boot({}, pending, 'contact');
    expect(contact.canSubmit()).toBe(false);
    contact.setNote(input('Đã gọi hai lần, khách hẹn gọi lại.'));
    expect(contact.canSubmit()).toBe(true);
  });

  it('demands a tracking code before a shipment step and proof before escalating', () => {
    const waiting: AdminReturnRow = { ...pending, status: 'WAITING_RETURN' };
    const flow$ = boot({}, waiting, 'status', 'RETURN_IN_TRANSIT');
    expect(flow$.needsTracking()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);
    flow$.setText('tracking', input('VLR-RETURN-9'));
    expect(flow$.canSubmit()).toBe(true);

    const support = boot({}, transit, 'status', 'NEEDS_SUPPORT');
    support.setNote(input('Hàng trả không đúng sản phẩm của shop.'));
    expect(support.canSubmit()).toBe(false);
    support.proof.set('https://cdn.velura.test/qa.jpg');
    expect(support.canSubmit()).toBe(true);
  });

  it('keeps a stale-version failure on screen instead of pretending success', () => {
    const flow$ = boot(
      {
        recordManualRefund: () =>
          throwError(() => new HttpErrorResponse({ status: 409, error: { error: { message: 'Phiếu đã thay đổi' } } })),
      },
      qaPassed,
      'manual',
    );
    flow$.setText('transferReference', input('FT2409012345'));
    flow$.proof.set('data:image/jpeg;base64,AAA');
    flow$.submit();

    expect(flow$.error()).toBe('Phiếu đã thay đổi');
    expect(flow$.saving()).toBe(false);
  });

  it('sends the manual refund reconciliation with the exact amount and transfer instant', () => {
    const sent: AdminManualRefundInput[] = [];
    const flow$ = boot(
      {
        recordManualRefund: (_id, body) => {
          sent.push(body);
          return of({ ...pending, status: 'COMPLETED' });
        },
      },
      qaPassed,
      'manual',
    );

    flow$.setNote(input('Đã chuyển khoản hoàn tiền cho khách.'));
    flow$.setText('transferReference', input('FT2409012345'));
    flow$.proof.set('data:image/jpeg;base64,AAA');
    flow$.submit();

    expect(sent[0].amount).toBe(500_000);
    expect(sent[0].transferReference).toBe('FT2409012345');
    expect(sent[0].expectedVersion).toBe(3);
    expect(typeof sent[0].transferredAt).toBe('string');
  });
});
