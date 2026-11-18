import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminErpApiService, AdminReturnItemActionInput, AdminReturnItemActionResult, AdminReturnLine, AdminReturnRow, AdminManualRefundInput } from '../../core/admin-erp-api.service';
import { QrConfirmFacts } from '../../shared/ui/admin-qr-confirm';
import { ReturnFlowComponent, ReturnFlowKind, ReturnFlowNext } from './return-flow.component';

/** Builds the change event a QA failure checkbox emits. */
function tick(checked = true): Event {
  return { target: { checked } } as unknown as Event;
}

/** Fixed facts a real scan would publish for the parcel under test. */
function qrFacts(overrides: Partial<QrConfirmFacts> = {}): QrConfirmFacts {
  return {
    raw: 'velura:return:1?id=return-1&code=RMA-001',
    returnCode: 'RMA-001',
    orderCode: 'VLR-777',
    carrier: 'GHN',
    trackingCode: 'GHNVL777',
    shipperName: 'Nguyễn Văn Giao',
    shipperPhone: '0909000111',
    scannedAt: '2026-11-08T02:00:00.000Z',
    ...overrides,
  };
}

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
    let actResult: AdminReturnItemActionResult = { return_id: 'return-1', item: part, lines: [part] };
    const api = {
      actOnReturnItem: (id: string, itemId: string, body: AdminReturnItemActionInput) => { actions.push({ id, itemId, body }); return of(actResult); },
      uploadReturnEvidence: (_id: string, _file: File, kind: string) => { uploads.push(kind); return of({ storage_ref: `private/${kind}/proof` }); },
      recordManualRefund: (_id: string, body: AdminManualRefundInput) => { manual.push(body); return of(record); },
      triggerStripeRefund: (_id: string, body: { expectedVersion: number; returnItemId: string }) => { stripe.push(body); return of({ success: true, refund: { status: 'requested' } }); },
      recordReturnContact: (_id: string, body: Record<string, unknown>) => { contacts.push(body); return of(record); },
      requestRefundInfo: () => of({}),
      analyzeReturnBoxForensics: () => of({
        box_condition: 'TORN_WET' as const,
        seal_intact: false,
        carrier_claim_recommended: true,
        match_verdict: 'SUSPICIOUS_DIFF' as const,
        diff_factors: ['SEAL_BROKEN' as const, 'TAPE_COLOR' as const],
        tampering_risk_score: 62,
        confidence_score: 0.87,
        requires_human_review: true,
        freeze_auto_refund: true,
        suggested_qa_failed_codes: ['condition_bad', 'seal_broken'],
        suggested_disposition: 'scrap' as const,
        discrepancy_evidence: ['Băng keo niêm phong rách và thùng ướt góc đáy.'],
        carrier_claim_report: {
          report_code: 'DSP-20261118-A1B2C3',
          generated_at: '2026-11-18T00:00:00Z',
          return_code: 'RMA-001',
          tracking_code: 'GHNVL777',
          carrier_name: 'GHN',
          box_condition: 'TORN_WET',
          match_verdict: 'SUSPICIOUS_DIFF',
          tampering_risk_score: 62,
          discrepancy_factors: ['SEAL_BROKEN', 'TAPE_COLOR'],
          recommended_claim_action: 'Lập biên bản bồi hoàn ĐVVC',
          summary_vi: '[DSP-20261118-A1B2C3] Thùng hàng rách ướt, niêm phong đổi màu băng keo.',
        },
      }),
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
    return { fixture, component: fixture.componentInstance, actions, manual, stripe, uploads, contacts, api, setResult: (item: AdminReturnLine) => { actResult = { return_id: 'return-1', item, lines: [item] }; } };
  }

  it('receives only the selected quantity with tag/condition/proof facts and seal false allowed', () => {
    const { component, actions, uploads } = boot('receive');
    component.quantity.set(1); component.receivedQuantity.set(1); component.toggleQaCriterion('seal_broken', tick()); component.proofFile.set(image);
    component.onQrFacts(qrFacts());
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

  describe('hand-off to the next exchange step', () => {
    /** Fills the receive form with a passing QA and submits it, collecting `next` then `done` in emit order. */
    function submitReceive(item: AdminReturnLine) {
      const booted = boot('receive');
      booted.setResult(item);
      const events: string[] = []; const nexts: ReturnFlowNext[] = [];
      booted.component.next.subscribe((value) => { nexts.push(value); events.push('next'); });
      booted.component.done.subscribe((value) => { events.push(`done:${value}`); });
      booted.component.proofFile.set(image); booted.component.onQrFacts(qrFacts());
      booted.component.submit();
      return { ...booted, events, nexts };
    }

    it('emits next prepare_exchange after a passed exchange receive, before done', () => {
      const { events, nexts } = submitReceive({ ...line, return_item_id: 'part-1', item_status: 'RECEIVED', resolution_type: 'exchange', exchange_order_id: null });
      expect(nexts).toEqual([{ kind: 'prepare_exchange', returnItemId: 'part-1' }]);
      expect(events).toEqual(['next', 'done:']);
    });

    it('targets the received part of the response, not the line that was acted on', () => {
      const { nexts } = submitReceive({ ...line, return_item_id: 'part-2', item_status: 'RECEIVED', resolution_type: 'exchange', exchange_order_id: null });
      expect(nexts).toEqual([{ kind: 'prepare_exchange', returnItemId: 'part-2' }]);
    });

    it('does not emit next when QA fails (NEEDS_SUPPORT) or the part is a refund', () => {
      const failed = submitReceive({ ...line, item_status: 'NEEDS_SUPPORT', resolution_type: 'exchange', exchange_order_id: null });
      expect(failed.nexts).toEqual([]);
      expect(failed.events).toEqual(['done:']);
      const refund = submitReceive({ ...line, item_status: 'RECEIVED', resolution_type: 'refund', exchange_order_id: null });
      expect(refund.nexts).toEqual([]);
      expect(refund.events).toEqual(['done:']);
    });

    it('emits open_exchange_order after prepare_exchange created the order', () => {
      const { component, setResult } = boot('prepare_exchange', { ...line, item_status: 'RECEIVED' });
      setResult({ ...line, item_status: 'EXCHANGE_PREPARING', exchange_order_id: 'exc-1' });
      const nexts: ReturnFlowNext[] = []; const dones: string[] = [];
      component.next.subscribe((value) => nexts.push(value)); component.done.subscribe((value) => dones.push(value));
      component.submit();
      expect(nexts).toEqual([{ kind: 'open_exchange_order', exchangeOrderId: 'exc-1' }]);
      expect(dones).toEqual(['']);
    });
  });

  it('words a gateway requested outcome as pending and always clears saving', () => {
    const { component, fixture } = boot('stripe', { ...line, item_status: 'RECEIVED', resolution_type: 'refund' });
    fixture.componentRef.setInput('record', { ...record, payment_kind: 'stripe', refund_flow: 'gateway_auto', refund_receiver_status: 'not_required' });
    fixture.detectChanges();
    let message = '';
    component.done.subscribe((value) => { message = value; });
    component.submit();
    expect(component.saving()).toBe(false);
    expect(message).toContain('chờ cổng');
    expect(message).not.toContain('đã hoàn tiền');
  });

  it('records mismatches for the affected part rather than blocking all receipt facts', () => {
    const { component } = boot('receive');
    component.proofFile.set(image); component.onQrFacts(qrFacts());
    component.toggleQaCriterion('wrong_product', tick()); component.disposition.set('repair');
    expect(component.matchesProduct()).toBe(false);
    expect(component.tagsIntact() && component.conditionAcceptable() && component.packageMatch() && component.sealIntact()).toBe(true);
    expect(component.canSubmit()).toBe(true);
  });

  it('flags every ticked QA failure and clears one when unticked', () => {
    const { component } = boot('receive');
    component.toggleQaCriterion('wrong_product', tick());
    component.toggleQaCriterion('tags_missing', tick());
    component.toggleQaCriterion('seal_broken', tick());
    expect([component.matchesProduct(), component.tagsIntact(), component.conditionAcceptable(), component.packageMatch(), component.sealIntact()])
      .toEqual([false, false, true, true, false]);
    component.toggleQaCriterion('tags_missing', tick(false));
    expect(component.tagsIntact()).toBe(true);
    expect(component.matchesProduct()).toBe(false);
  });

  it('requires the operator to type the shipper name when the label prints none', () => {
    const { component } = boot('pickup', { ...line, item_status: 'WAITING_RETURN' });
    component.pickupPhotos.set([image]);
    component.onQrFacts(qrFacts({ shipperName: '' }));
    expect(component.pickedUpBy()).toBe('');
    expect(component.canSubmit()).toBe(false);
    component.setText('pickedUpBy', { target: { value: 'Trần Văn Nhận' } } as unknown as Event);
    expect(component.canSubmit()).toBe(true);
  });

  it('does not accept zero, fractional, excessive quantities or missing warehouse proof', () => {
    const { component } = boot('receive');
    expect(component.canSubmit()).toBe(false);
    component.proofFile.set(image); component.onQrFacts(qrFacts());
    for (const quantity of [0, 1.5, 4]) { component.quantity.set(quantity); component.receivedQuantity.set(quantity); expect(component.canSubmit()).toBe(false); }
  });

  it('requires explicit super-admin approval capability and an audited decision reason', () => {
    const part = { ...line, decision_status: 'pending' as const, item_status: 'REQUESTED' };
    const { component, fixture, actions } = boot('approve', part, false);
    component.note.set('Đã xác minh bằng chứng và lịch sử gọi không nghe máy');
    expect(component.canSubmit()).toBe(false);
    fixture.componentRef.setInput('canApprove', true); fixture.detectChanges();
    component.note.set('Đã xác minh bằng chứng và lịch sử gọi không nghe máy');
    expect(component.needsQrScan()).toBe(false);
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

  it('prefills a unique outbound AWB for the exchange shipment instead of reusing the return code', () => {
    const { component } = boot('ship_exchange', { ...line, item_status: 'EXCHANGE_PREPARING', resolution_type: 'exchange' });
    expect(component.tracking()).toMatch(/^EXC[A-Z0-9]{8,}$/);
    component.proofFile.set(image);
    expect(component.canSubmit()).toBe(false);
    component.onQrFacts(qrFacts({ trackingCode: 'RET1F28AB9201F745388B608B7485FAAA88' }));
    expect(component.canSubmit()).toBe(true);
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

  it('sends the gateway refund for a VNPay/MoMo part and words the result without Stripe', () => {
    const gateway: AdminReturnRow = {
      ...record, payment_kind: 'other_online', refund_flow: 'gateway_auto', refund_receiver_status: 'not_required',
    };
    const { component, fixture, stripe } = boot('stripe', { ...line, resolution_type: 'refund', item_status: 'RECEIVED' });
    const messages: string[] = []; component.done.subscribe((message) => messages.push(message));
    fixture.componentRef.setInput('record', gateway); fixture.detectChanges();
    expect(component.canSubmit()).toBe(true);
    component.submit();
    expect(stripe).toEqual([{ expectedVersion: 7, returnItemId: 'part-1' }]);
    expect(messages[0]).toContain('cổng thanh toán');
    expect(messages[0]).not.toContain('Stripe');
    expect(component.quickNotes().join(' ')).not.toContain('qua thẻ');
  });

  it('reconciles an online part by hand only once its gateway refund was refused', () => {
    const gateway: AdminReturnRow = {
      ...record, payment_kind: 'other_online', refund_flow: 'gateway_auto', refund_receiver_status: 'not_required',
    };
    const { component, fixture, manual } = boot('manual', { ...line, resolution_type: 'refund', item_status: 'RECEIVED' });
    fixture.componentRef.setInput('record', gateway); fixture.detectChanges();
    component.transferReference.set('VCB-REF-998877'); component.transferredAt.set('2020-01-01T10:00'); component.proofFile.set(image);
    expect(component.canSubmit()).toBe(false);

    // Cổng đã từ chối nhưng chưa có tài khoản nhận: migration 113 vẫn từ chối ghi tay, nên UI không mở nút.
    fixture.componentRef.setInput('record', { ...gateway, gateway_refund_failed: true });
    fixture.detectChanges();
    expect(component.canSubmit()).toBe(false);

    // Từ chối + tài khoản nhận hợp lệ → đây là lúc duy nhất được trả tiền bằng chuyển khoản.
    fixture.componentRef.setInput('record', { ...gateway, gateway_refund_failed: true, refund_receiver_status: 'valid' });
    fixture.detectChanges();
    expect(component.canSubmit()).toBe(true);
    component.submit();
    expect(manual[0].returnItemId).toBe('part-1');
    expect(manual[0].amount).toBe(120_000);
  });

  it('takes the pickup identity, AWB and time from the scanned label', () => {
    const { component, actions } = boot('pickup', { ...line, item_status: 'WAITING_RETURN' });
    component.pickupPhotos.set([image]); component.proofFile.set(image);
    // No scan → the step cannot be saved, no matter what else is filled in.
    expect(component.canSubmit()).toBe(false);
    component.onQrFacts(qrFacts({ returnCode: 'RMA-001', orderCode: 'VLR-777', trackingCode: 'GHN-PICKUP-001' }));
    expect(component.canSubmit()).toBe(true);
    component.submit();
    expect(actions[0].body.pickedUpBy).toBe('Nguyễn Văn Giao');
    expect(actions[0].body.trackingNumber).toBe('GHN-PICKUP-001');
    expect(actions[0].body.carrier).toBe('GHN');
    expect(actions[0].body.photoUrls).toEqual(['private/pickup_photo/proof']);
  });

  it('shows stale-version failure without emitting successful completion', () => {
    const { component, api } = boot('receive');
    api.actOnReturnItem = () => throwError(() => new Error('Phiên bản đã thay đổi'));
    component.proofFile.set(image); component.onQrFacts(qrFacts()); let completed = false; component.done.subscribe(() => { completed = true; });
    component.submit(); expect(completed).toBe(false); expect(component.error()).toContain('Phiên bản'); expect(component.saving()).toBe(false);
  });

  it('keeps no-answer outreach on the request contact endpoint and request version', () => {
    const { component, contacts, actions } = boot('contact');
    component.note.set('Đã gọi hai lần, chưa liên hệ được khách'); component.contactResult.set('no_answer'); component.submit();
    expect(contacts[0]).toEqual({ result: 'no_answer', note: 'Đã gọi hai lần, chưa liên hệ được khách', expectedVersion: 42 });
    expect(actions).toEqual([]);
  });

  it('approves the quantity the customer requested without any parcel scan', () => {
    const part: AdminReturnLine = { ...line, decision_status: 'pending', item_status: 'REQUESTED' };
    const { component, actions } = boot('approve', part);
    expect(component.showQuantityEditor()).toBe(false);
    component.note.set('Đã gọi xác nhận đổi size với khách');
    expect(component.canSubmit()).toBe(true); component.submit();
    expect(actions[0].body.quantity).toBe(3);
  });

  it('writes confirmed call facts into the stored contact note once each', () => {
    const { component, contacts } = boot('contact');
    component.appendFact('Xác nhận yêu cầu đổi trả'); component.appendFact('Xác nhận yêu cầu đổi trả');
    component.note.set(component.note() + ' Khách đổi sang size M.');
    component.submit();
    expect(contacts[0]['note']).toBe('Xác nhận yêu cầu đổi trả. Khách đổi sang size M.');
  });

  it('keeps the scanned facts read-only and copies them into the stored handover', () => {
    const { component } = boot('pickup', { ...line, item_status: 'WAITING_RETURN' });
    component.onQrFacts(qrFacts({ returnCode: 'RMA-001', orderCode: 'VLR-777', trackingCode: 'GHN-99887766' }));
    expect(component.qrFacts()?.returnCode).toBe('RMA-001');
    expect(component.carrier()).toBe('GHN');
    expect(component.tracking()).toBe('GHN-99887766');
    expect(component.pickedUpBy()).toBe('Nguyễn Văn Giao');
    // A new flow starts from the camera again; facts are never carried across parts.
    component.onQrFacts(null);
    expect(component.qrFacts()).toBeNull();
  });

  it('runs Gemini Decision 1 box forensics, flags grey-zone HITL, and applies 1-click QA & carrier claim summary', () => {
    const { component, fixture } = boot('receive');
    fixture.componentRef.setInput('record', { ...record, warehouse_proof: 'private/qa_photo/existing' });
    fixture.detectChanges();

    component.runAiBoxForensics();
    expect(component.boxForensics()?.box_condition).toBe('TORN_WET');
    expect(component.isGreyZoneRisk()).toBe(true);

    component.applyForensicsSuggestions();
    expect(component.conditionAcceptable()).toBe(false);
    expect(component.sealIntact()).toBe(false);
    expect(component.disposition()).toBe('scrap');
    expect(component.note()).toContain('DSP-20261118-A1B2C3');
  });
});
