import { TestBed } from '@angular/core/testing';
import { DeliverySimulation } from './delivery-simulation';

describe('DeliverySimulation', () => {
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({ imports: [DeliverySimulation] }); });
  afterEach(() => vi.useRealTimers());

  it('stops the illustrative route before completion while the actual order is shipping', () => {
    const fixture = TestBed.createComponent(DeliverySimulation);
    fixture.componentRef.setInput('orderCode', 'DEMO-ORDER');
    fixture.componentRef.setInput('delivered', false);
    fixture.detectChanges();
    fixture.componentInstance.toggle();
    vi.advanceTimersByTime(25000);
    expect(fixture.componentInstance.displayedProgress()).toBe(95);
    expect(fixture.componentInstance.delivered()).toBe(false);
    expect(fixture.componentInstance.running()).toBe(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Đơn đang giao hàng');
    expect(fixture.nativeElement.textContent).toContain('không phải vị trí GPS thực tế');
  });

  it('shows arrival only when its order input says delivered and clears its timer on destroy', () => {
    const fixture = TestBed.createComponent(DeliverySimulation);
    fixture.componentRef.setInput('orderCode', 'DEMO-ORDER');
    fixture.componentInstance.toggle();
    fixture.componentRef.setInput('delivered', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.displayedProgress()).toBe(100);
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
