import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, convertToParamMap, provideRouter } from '@angular/router';
import { PurchaseDemoStore } from '../services/purchase-demo.store';
import { purchaseFlowGuard } from './purchase-flow.guard';

describe('Guest/User purchase entry points', () => {
  const member = signal(false);
  beforeEach(() => {
    member.set(false);
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: PurchaseDemoStore, useValue: { member } }] });
  });
  afterEach(() => TestBed.resetTestingModule());

  function enter(path: string, audience: string, area: string, id?: string): string | boolean {
    const route = new ActivatedRouteSnapshot();
    route.data = { audience, area };
    route.queryParams = {};
    Object.defineProperty(route, 'routeConfig', { value: { path } });
    Object.defineProperty(route, 'paramMap', { value: convertToParamMap(id ? { id } : {}) });
    const result = TestBed.runInInjectionContext(() => purchaseFlowGuard(route, {} as RouterStateSnapshot));
    return typeof result === 'boolean' ? result : TestBed.inject(Router).serializeUrl(result as ReturnType<Router['createUrlTree']>);
  }

  it('sends anonymous member checkout links to Guest checkout', () => {
    expect(enter('checkout/user', 'user', 'checkout')).toBe('/checkout/guest');
    expect(enter('checkout/guest', 'guest', 'checkout')).toBe(true);
  });
  it('selects member checkout only from a signed-in identity', () => {
    member.set(true);
    expect(enter('checkout/guest', 'entry', 'checkout')).toBe('/checkout/user');
    expect(enter('checkout/guest', 'guest', 'checkout')).toBe('/checkout/user');
  });
  it('preserves an order reference when redirecting to Guest verification', () => {
    expect(enter('account/orders/:id', 'user', 'orders', 'DEMO-123')).toBe('/guest/orders?order=DEMO-123');
  });
  it('preserves the after-sales destination in both directions', () => {
    expect(enter('account/returns', 'user', 'orders')).toBe('/guest/returns');
    member.set(true);
    expect(enter('guest/returns', 'guest', 'orders')).toBe('/account/returns');
  });
});
