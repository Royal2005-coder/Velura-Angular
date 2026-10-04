import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CartStore, type CartLine } from './cart.store';
import { CheckoutStore } from './checkout.store';

describe('CheckoutStore purchase provenance', () => {
  const line: CartLine = { variant_id: 'shirt-m', product_id: 'shirt', product_name: 'Shirt', product_image: '', quantity: 3, unit_price: 100 };
  const cart = { items: signal<CartLine[]>([]), replaceItems: vi.fn() };
  let checkout: CheckoutStore;
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    cart.items.set([line]); cart.replaceItems.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: CartStore, useValue: cart }] });
    checkout = TestBed.inject(CheckoutStore);
  });
  it('does not consume a matching cart variant after a buy-now purchase', () => {
    checkout.setCheckoutItems([{ ...line, quantity: 1 }], 'buy_now');
    checkout.completeCheckout(checkout.items());
    expect(cart.replaceItems).not.toHaveBeenCalled();
    expect(cart.items()).toEqual([line]);
  });
  it('consumes only ordered quantities of the selected line identity, preserving combos', () => {
    const combo = { ...line, quantity: 2, combo_id: 'outfit' };
    cart.items.set([line, combo]);
    checkout.setCheckoutItems([{ ...line, quantity: 1 }], 'cart');
    checkout.completeCheckout(checkout.items());
    expect(cart.replaceItems).toHaveBeenCalledWith([{ ...line, quantity: 2 }, combo]);
    expect(line.quantity).toBe(3);
  });
  it('preserves buy-now provenance across inline changes and reloads, including an empty selection', () => {
    checkout.setCheckoutItems([line], 'buy_now');
    checkout.setCheckoutItems([]);
    expect(checkout.source()).toBe('buy_now');
    expect(checkout.readCheckoutItems()).toEqual([]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: CartStore, useValue: cart }] });
    const reloaded = TestBed.inject(CheckoutStore);
    expect(reloaded.source()).toBe('buy_now');
    expect(reloaded.items()).toEqual([]);
  });
});
