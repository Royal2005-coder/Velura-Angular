import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  AdminErpApiService,
  AdminManualRefundInput,
  AdminRefundApprovalInput,
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
  function boot(api: Partial<AdminErpApiService>, record: AdminReturnRow, flow: string | null) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReturnFlowComponent],
      providers: [{ provide: AdminErpApiService, useValue: api }],
    });
    const fixture = TestBed.createComponent(ReturnFlowComponent);
    fixture.componentRef.setInput('record', record);
    fixture.componentRef.setInput('flow', flow);
    fixture.detectChanges();
    fixture.componentInstance.prepare();
    return fixture.componentInstance;
  }

  it('prefills the refundable amount and refuses to ask for more than the goods are worth', () => {
    const flow$ = boot({}, pending, 'refund');

    expect(flow$.amount()).toBe(500_000);
    flow$.setNote(input('Khách gửi ảnh lỗi, đã gọi xác nhận hoàn tiền.'));
    expect(flow$.canSubmit()).toBe(true);

    flow$.setAmount(input('700000'));
    expect(flow$.amountMismatch()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);
  });

  it('waives the approval reason once a contact note exists', () => {
    const calls: AdminRefundApprovalInput[] = [];
    const flow$ = boot(
      {
        approveRefund: (_id, body) => {
          calls.push(body);
          return of({ ...pending, version: 4, refund: null });
        },
      },
      { ...pending, admin_note: '[CSKH 2026-10-20] gọi khách' },
      'refund',
    );

    expect(flow$.requiresReason()).toBe(false);
    expect(flow$.canSubmit()).toBe(true);
    flow$.submit();

    expect(calls[0]).toEqual({ refundAmount: 500_000, adminNote: '', expectedVersion: 3 });
  });

  it('executes the Stripe refund the approval just authorized, in one step', () => {
    const gateway: Array<Record<string, unknown>> = [];
    const row: AdminReturnRow = {
      ...pending,
      status: 'RECEIVED',
      payment_kind: 'stripe',
      refund_flow: 'stripe_auto',
      refund_receiver_status: 'valid',
      condition_check_result: 'qa_pass',
    };
    const flow$ = boot(
      {
        approveRefund: () => of({ ...row, status: 'REFUND_PROCESSING', version: 4, condition_check_result: 'qa_pass', refund: null }),
        triggerStripeRefund: (_id, body) => {
          gateway.push(body);
          return of({ success: true, refund: { status: 'refunded' } });
        },
      },
      row,
      'refund',
    );
    const notes: string[] = [];
    flow$.done.subscribe((message) => notes.push(message));
    flow$.setNote(input('Khách đã gửi đủ ảnh minh chứng lỗi sản phẩm.'));
    flow$.submit();

    expect(gateway).toEqual([{ expectedVersion: 4 }]);
    expect(notes).toEqual(['Stripe đã hoàn tiền. Phiếu sẽ được đánh dấu hoàn tất theo luồng.']);
  });

  it('keeps the approval and says so when the gateway refuses', () => {
    const row: AdminReturnRow = { ...pending, status: 'RECEIVED', payment_kind: 'stripe', refund_flow: 'stripe_auto', condition_check_result: 'qa_pass' };
    const flow$ = boot(
      {
        approveRefund: () => of({ ...row, status: 'REFUND_PROCESSING', version: 4, condition_check_result: 'qa_pass', refund: null }),
        triggerStripeRefund: () => throwError(() => new Error('gateways down')),
      },
      row,
      'refund',
    );
    const notes: string[] = [];
    flow$.done.subscribe((message) => notes.push(message));
    flow$.setNote(input('Kho đã nhận hàng và kiểm đạt, hoàn tiền theo giá trị hàng trả.'));
    flow$.submit();

    expect(notes[0]).toContain('Đã duyệt hoàn tiền, nhưng cổng chưa chạy');
    expect(flow$.saving()).toBe(false);
  });

  it('leaves COD approvals to the transfer flow instead of calling a card gateway', () => {
    const triggered: string[] = [];
    const flow$ = boot(
      {
        approveRefund: () => of({ ...pending, status: 'REFUND_PROCESSING', version: 4, refund: null }),
        triggerStripeRefund: (id) => {
          triggered.push(id);
          return of({ success: true, refund: { status: 'refunded' } });
        },
      },
      pending,
      'refund',
    );
    flow$.setNote(input('COD: kế toán sẽ chuyển khoản theo biên bản kho.'));
    flow$.submit();

    expect(triggered).toEqual([]);
  });

  it('requires a ten-character reason for rejection and outreach', () => {    const rejected = boot({}, pending, 'reject');
    rejected.setNote(input('ngắn'));
    expect(rejected.canSubmit()).toBe(false);
    rejected.setNote(input('Sản phẩm còn hạn bảo hành, khách đổi ý nên từ chối.'));
    expect(rejected.canSubmit()).toBe(true);

    const contact = boot({}, pending, 'contact');
    expect(contact.canSubmit()).toBe(false);
    contact.setNote(input('Đã gọi hai lần, khách hẹn gọi lại.'));
    expect(contact.canSubmit()).toBe(true);
  });

  it('blocks the warehouse receipt until every line is confirmed with proof', () => {
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
      { orderItemId: 'i-1', receivedQuantity: 2, matchesProduct: true },
      { orderItemId: 'i-2', receivedQuantity: 1, matchesProduct: true },
    ]);
  });

  it('keeps the transfer record honest about reference, proof and amount', () => {
    const sent: AdminManualRefundInput[] = [];
    const flow$ = boot(
      {
        recordManualRefund: (_id, body) => {
          sent.push(body);
          return of({ ...pending, status: 'COMPLETED' });
        },
      },
      { ...pending, status: 'RECEIVED', condition_check_result: 'qa_pass', refund_receiver_status: 'valid' },
      'manual',
    );

    expect(flow$.canSubmit()).toBe(false);
    flow$.setNote(input('Đã chuyển khoản hoàn tiền cho khách.'));
    expect(flow$.canSubmit()).toBe(false);

    flow$.setText('transferReference', input('FT2409012345'));
    flow$.proof.set('data:image/jpeg;base64,AAA');
    expect(flow$.canSubmit()).toBe(true);

    flow$.submit();
    const body = sent[0];
    expect(body.amount).toBe(500_000);
    expect(body.transferReference).toBe('FT2409012345');
    expect(body.expectedVersion).toBe(3);
    expect(typeof body.transferredAt).toBe('string');
  });

  it('demands a tracking code before a shipment step and proof before escalating', () => {
    const flow$ = boot({}, transit, 'status');
    flow$.setTargetStatus({ target: { value: 'RETURN_IN_TRANSIT' } } as unknown as Event);
    expect(flow$.needsTracking()).toBe(true);
    expect(flow$.canSubmit()).toBe(false);
    flow$.setText('tracking', input('VLR-RETURN-9'));
    expect(flow$.canSubmit()).toBe(true);

    const support = boot({}, transit, 'status');
    support.setTargetStatus({ target: { value: 'NEEDS_SUPPORT' } } as unknown as Event);
    support.setNote(input('Hàng trả không đúng sản phẩm của shop.'));
    expect(support.canSubmit()).toBe(false);
    support.proof.set('https://cdn.velura.test/qa.jpg');
    expect(support.canSubmit()).toBe(true);
  });

  it('keeps a stale-version failure on screen instead of pretending success', () => {
    const flow$ = boot(
      {
        approveRefund: () =>
          throwError(() => new HttpErrorResponse({ status: 409, error: { error: { message: 'Phiếu đã thay đổi' } } })),
      },
      pending,
      'refund',
    );
    flow$.setNote(input('Ghi nhận hoàn tiền theo biên bản kho.'));
    flow$.submit();

    expect(flow$.error()).toBe('Phiếu đã thay đổi');
    expect(flow$.saving()).toBe(false);
  });
});
