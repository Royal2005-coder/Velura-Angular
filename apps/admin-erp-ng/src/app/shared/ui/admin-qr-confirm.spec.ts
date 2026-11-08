import { TestBed } from '@angular/core/testing';
import { AdminErpQrConfirm, QrConfirmFacts } from './admin-qr-confirm';

describe('AdminErpQrConfirm', () => {
  function boot(kind: 'order' | 'return') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [AdminErpQrConfirm] });
    const fixture = TestBed.createComponent(AdminErpQrConfirm);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('recordId', kind === 'order' ? 'o1' : 'return-1');
    fixture.componentRef.setInput('recordCode', kind === 'order' ? 'VL-1001' : 'RMA-001');
    fixture.detectChanges();
    const emitted: QrConfirmFacts[] = [];
    fixture.componentInstance.facts.subscribe((facts) => emitted.push(facts));
    return { component: fixture.componentInstance, emitted };
  }

  it('publishes the fixed facts of the scanned order label', () => {
    const { component, emitted } = boot('order');

    component.applyScan('velura:shipment:1?order=VL-1001&carrier=GHN&tracking=GHN998&shipper=Nguy%E1%BB%85n%20Giao&shipperPhone=0909000111');

    expect(component.error()).toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].orderCode).toBe('VL-1001');
    expect(emitted[0].carrier).toBe('GHN');
    expect(emitted[0].trackingCode).toBe('GHN998');
    expect(emitted[0].shipperName).toBe('Nguyễn Giao');
    expect(emitted[0].scannedAt).not.toBe('');
  });

  it('refuses a label that belongs to another order', () => {
    const { component, emitted } = boot('order');

    component.applyScan('velura:order:1?id=o2&code=VL-9000');

    expect(component.error()).toContain('đơn khác');
    expect(component.current()).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('refuses a plain tracking number for order confirmation', () => {
    const { component } = boot('order');

    component.applyScan('GHN-99887766');

    expect(component.error()).toContain('số vận đơn');
    expect(component.current()).toBeNull();
  });

  it('accepts this return paperwork and keeps the known carrier as fallback', () => {
    const { component, emitted } = boot('return');
    component.applyScan('velura:return:1?id=return-1&code=RMA-001');

    expect(component.error()).toBeNull();
    expect(emitted[0].returnCode).toBe('RMA-001');
    expect(emitted[0].carrier).toBe('');
  });

  it('refuses the paperwork of another return', () => {
    const { component } = boot('return');

    component.applyScan('velura:return:1?id=other-return&code=RMA-001');

    expect(component.error()).toContain('phiếu đổi trả khác');
    expect(component.current()).toBeNull();
  });
});
