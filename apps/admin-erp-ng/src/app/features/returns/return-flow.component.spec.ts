import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminErpApiService, AdminReturnItemActionInput, AdminReturnLine, AdminReturnRow, AdminManualRefundInput } from '../../core/admin-erp-api.service';
import { ReturnFlowComponent, ReturnFlowKind } from './return-flow.component';

const line: AdminReturnLine = { return_item_id: 'part-1', order_item_id: 'order-line', quantity: 3, version: 7, decision_status: 'approved', item_status: 'RETURN_SHIPPING', resolution_type: 'exchange', refundable_amount: 120_000 };
const record: AdminReturnRow = { return_id: 'return-1', return_type: 'exchange', version: 42, status: 'IN_PROGRESS', payment_kind: 'cod', refund_flow: 'cod_manual', refund_receiver_status: 'valid', lines: [line] };
const image = new File(['proof'], 'proof.jpg', { type: 'image/jpeg' });

describe('ReturnFlowComponent per-item operations', () => {
  function boot(flow: Exclude<ReturnFlowKind, null>, part: AdminReturnLine = line, canApprove = true) {
    TestBed.resetTestingModule();
    const actions: { id: string; itemId: string; body: AdminReturnItemActionInput }[] = [];
    const manual: AdminManualRefundInput[] = [];
    const stripe: { expectedVersion: number; returnItemId: string }[] = [];
    const uploads: string[] = [];
    const contacts: Record<string, unknown>[] = [];
    const api = {
      actOnReturnItem: (id: string, itemId: string, body: AdminReturnItemActionInput) => { actions.push({ id, itemId, body }); return of(record); },
      uploadReturnEvidence: (_id: string, _file: File, kind: string) => { uploads.push(kind); return of({ storage_ref: `private/${kind}/proof` }); },
      recordManualRefund: (_id: string, body: AdminManualRefundInput) => { manual.push(body); return of(record); },
      triggerStripeRefund: (_id: string, body: { expectedVersion: number; returnItemId: string }) => { stripe.push(body); return of({ success: true, refund: { status: 'requested' } }); },
      recordReturnContact: (_id: string, body: Record<string, unknown>) => { contacts.push(body); return of(record); },
      requestRefundInfo: () => of({}),
      listVariants: (_pid: string) => of({
        rows: [
          { variant_id: 'var-s', color: 'Xanh', size: 'S', stock_quantity: 5, reserved_quantity: 0 },
          { variant_id: 'var-m', color: 'Xanh', size: 'M', stock_quantity: 1, reserved_quantity: 1 },
          { variant_id: 'var-l', color: 'Xanh', size: 'L', stock_quantity: 10, reserved_quantity: 2 },
        ],
        count: 3,
      }),
    };
    TestBed.configureTestingModule({ imports: [ReturnFlowComponent], providers: [{ provide: AdminErpApiService, useValue: api }] });
    const fixture = TestBed.createComponent(ReturnFlowComponent);
    fixture.componentRef.setInput('flow', flow); fixture.componentRef.setInput('record', record);
    fixture.componentRef.setInput('line', part); fixture.componentRef.setInput('canApprove', canApprove);
    fixture.componentRef.setInput('canOperate', true); fixture.componentRef.setInput('canFinance', true);
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, actions, manual, stripe, uploads, contacts, api };
  }

  it('receives only the selected quantity with tag/condition/proof facts and seal false allowed', () => {
    const { component, actions, uploads } = boot('receive');
    component.quantity.set(1); component.receivedQuantity.set(1); component.sealIntact.set(false); component.proofFile.set(image);
    expect(component.canSubmit()).toBe(true);
    component.submit();
    expect(uploads).toEqual(['qa_photo']);
    expect(actions).toEqual([{ id: 'return-1', itemId: 'part-1', body: {
      action: 'receive', expectedVersion: 7, quantity: 1, receivedQuantity: 1,
      matchesProduct: true, tagsIntact: true, conditionAcceptable: true, packageMatch: true, sealIntact: false,
      disposition: 'restock', dispositionNote: '', receiptProofRef: 'private/qa_photo/proof',
    } }]);
    expect(record.return_type).toBe('exchange');
  });

  it('records mismatches for the affected part rather than blocking all receipt facts', () => {
    const { component } = boot('receive');
    component.proofFile.set(image); component.matchesProduct.set(false); component.tagsIntact.set(false);
    component.conditionAcceptable.set(false); component.disposition.set('repair');
    expect(component.canSubmit()).toBe(true);
  });

  it('does not accept zero, fractional, excessive quantities or missing warehouse proof', () => {
    const { component } = boot('receive');
    expect(component.canSubmit()).toBe(false);
    component.proofFile.set(image);
    for (const quantity of [0, 1.5, 4]) { component.quantity.set(quantity); component.receivedQuantity.set(quantity); expect(component.canSubmit()).toBe(false); }
  });

  it('requires explicit super-admin approval capability and an audited decision reason', () => {
    const part = { ...line, decision_status: 'pending' as const, item_status: 'REQUESTED' };
    const { component, fixture, actions } = boot('approve', part, false);
    component.note.set('Đã xác minh bằng chứng và lịch sử gọi không nghe máy');
    expect(component.canSubmit()).toBe(false);
    fixture.componentRef.setInput('canApprove', true); fixture.detectChanges();
    component.note.set('Đã xác minh bằng chứng và lịch sử gọi không nghe máy');
    expect(component.canSubmit()).toBe(true); component.submit();
    expect(actions[0].body.action).toBe('approve');
    expect(actions[0].body.expectedVersion).toBe(7);
  });

  it('requires consent and reason to convert one exchange part without rewriting request type', () => {
    const { component, actions } = boot('convert_refund', { ...line, item_status: 'RECEIVED' });
    component.note.set('Khách đồng ý hoàn tiền qua cuộc gọi hôm nay');
    expect(component.canSubmit()).toBe(false);
    component.customerConsent.set(true); component.quantity.set(2);
    component.submit();
    expect(actions[0].body).toEqual({ action: 'convert_refund', expectedVersion: 7, quantity: 2, reason: 'Khách đồng ý hoàn tiền qua cuộc gọi hôm nay', customerConsent: true });
    expect(record.return_type).toBe('exchange');
  });

  it('populates same-product variant choices, disables out of stock variants, and submits selection with consent', () => {
    const partWithProduct = { ...line, product_id: 'prod-1', quantity: 2 };
    const { component, actions } = boot('change_variant', partWithProduct);
    expect(component.variantChoices().length).toBe(3);
    component.note.set('Khách đồng ý đổi sang size S còn hàng'); component.customerConsent.set(true);
    // var-m has stock 1, reserved 1 -> available 0, so selecting it disables submission
    component.replacementVariantId.set('var-m');
    expect(component.canSubmit()).toBe(false);
    // var-s has stock 5, reserved 0 -> available 5, enough for quantity 2
    component.replacementVariantId.set('var-s');
    expect(component.canSubmit()).toBe(true);
    component.submit();
    expect(actions[0].body.replacementVariantId).toBe('var-s');
    expect(actions[0].body.customerConsent).toBe(true);
    expect(actions[0].itemId).toBe('part-1');
  });

  it('records COD payment against the item allocation and version, never the header total/version', () => {
    const { component, manual } = boot('manual', { ...line, resolution_type: 'refund', item_status: 'RECEIVED' });
    component.transferReference.set('BANK-REF-001'); component.transferredAt.set('2020-01-01T10:00'); component.proofFile.set(image);
    expect(component.canSubmit()).toBe(true); component.submit();
    expect(manual[0].returnItemId).toBe('part-1'); expect(manual[0].expectedVersion).toBe(7);
    expect(manual[0].amount).toBe(120_000); expect(manual[0].imageProof).toBe('private/refund_proof/proof');
  });

  it('blocks manual payments for online channels and for nonfinancial operators', () => {
    const { component, fixture } = boot('manual', { ...line, resolution_type: 'refund', item_status: 'RECEIVED' });
    component.transferReference.set('BANK-REF-001'); component.transferredAt.set('2020-01-01T10:00'); component.proofFile.set(image);
    fixture.componentRef.setInput('record', { ...record, payment_kind: 'other_online' }); fixture.detectChanges();
    expect(component.canSubmit()).toBe(false);
    fixture.componentRef.setInput('record', record); fixture.componentRef.setInput('canFinance', false); fixture.detectChanges();
    expect(component.canSubmit()).toBe(false);
  });

  it('requires real pickup identity and nonfuture time and submits them with private proof', () => {
    const { component, actions } = boot('pickup', { ...line, item_status: 'WAITING_RETURN' });
    component.pickupPhotos.set([image]); component.tracking.set('GHN-PICKUP-001');
    expect(component.canSubmit()).toBe(false);
    component.pickedUpBy.set('Nguyễn giao nhận'); component.pickedUpAt.set('2999-01-01T10:00');
    expect(component.canSubmit()).toBe(false);
    component.pickedUpAt.set('2020-01-01T10:00'); expect(component.canSubmit()).toBe(true); component.submit();
    expect(actions[0].body.pickedUpBy).toBe('Nguyễn giao nhận');
    expect(actions[0].body.pickedUpAt).toBe(new Date('2020-01-01T10:00').toISOString());
    expect(actions[0].body.photoUrls).toEqual(['private/pickup_photo/proof']);
  });

  it('shows stale-version failure without emitting successful completion', () => {
    const { component, api } = boot('receive');
    api.actOnReturnItem = () => throwError(() => new Error('Phiên bản đã thay đổi'));
    component.proofFile.set(image); let completed = false; component.done.subscribe(() => { completed = true; });
    component.submit(); expect(completed).toBe(false); expect(component.error()).toContain('Phiên bản'); expect(component.saving()).toBe(false);
  });

  it('keeps no-answer outreach on the request contact endpoint and request version', () => {
    const { component, contacts, actions } = boot('contact');
    component.note.set('Đã gọi hai lần, chưa liên hệ được khách'); component.contactResult.set('no_answer'); component.submit();
    expect(contacts[0]).toEqual({ result: 'no_answer', note: 'Đã gọi hai lần, chưa liên hệ được khách', expectedVersion: 42 });
    expect(actions).toEqual([]);
  });
});
