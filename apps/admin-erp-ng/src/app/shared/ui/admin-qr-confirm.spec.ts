import { TestBed } from '@angular/core/testing';
import { AdminErpQrConfirm, QrConfirmFacts } from './admin-qr-confirm';

describe('AdminErpQrConfirm', () => {
  function boot() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [AdminErpQrConfirm] });
    const fixture = TestBed.createComponent(AdminErpQrConfirm);
    fixture.componentRef.setInput('recordId', 'return-1');
    fixture.componentRef.setInput('recordCode', 'RMA-001');
    fixture.detectChanges();
    const emitted: QrConfirmFacts[] = [];
    fixture.componentInstance.facts.subscribe((facts) => emitted.push(facts));
    return { component: fixture.componentInstance, emitted };
  }

  it('refuses the order QR: only return paperwork or the return waybill is accepted', () => {
    const { component, emitted } = boot();

    component.applyScan('velura:order:1?id=o2&code=VL-9000');

    expect(component.error()).toContain('không phải phiếu đổi trả');
    expect(component.current()).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('publishes the fixed facts of a return waybill label', () => {
    const { component, emitted } = boot();

    component.applyScan('velura:shipment:1?carrier=GHN&tracking=GHN998&shipper=Nguy%E1%BB%85n%20Giao&shipperPhone=0909000111');

    expect(component.error()).toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].returnCode).toBe('RMA-001');
    expect(emitted[0].carrier).toBe('GHN');
    expect(emitted[0].trackingCode).toBe('GHN998');
    expect(emitted[0].shipperName).toBe('Nguyễn Giao');
    expect(emitted[0].scannedAt).not.toBe('');
  });

  it('accepts this return paperwork and keeps the known carrier as fallback', () => {
    const { component, emitted } = boot();
    component.applyScan('velura:return:1?id=return-1&code=RMA-001');

    expect(component.error()).toBeNull();
    expect(emitted[0].returnCode).toBe('RMA-001');
    expect(emitted[0].carrier).toBe('');
  });

  it('refuses the paperwork of another return', () => {
    const { component } = boot();

    component.applyScan('velura:return:1?id=other-return&code=RMA-001');

    expect(component.error()).toContain('phiếu đổi trả khác');
    expect(component.current()).toBeNull();
  });
});
