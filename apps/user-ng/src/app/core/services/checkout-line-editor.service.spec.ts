import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CatalogService } from './catalog.service';
import { CartStore, type CartLine } from './cart.store';
import { CheckoutStore } from './checkout.store';
import { CheckoutLineEditorService } from './checkout-line-editor.service';

describe('CheckoutLineEditorService', () => {
  const original: CartLine = { variant_id: 'black-m', product_id: 'shirt', product_name: 'Shirt', product_image: '', unit_price: 100, quantity: 1 };
  const cart = { items: signal<CartLine[]>([]), replaceItems: vi.fn() };
  const checkout = { setCheckoutItems: vi.fn(), source: signal<'cart' | 'buy_now'>('cart') };
  let editor: CheckoutLineEditorService;
  beforeEach(() => {
    cart.items.set([]); cart.replaceItems.mockReset(); checkout.setCheckoutItems.mockReset();
    checkout.source.set('cart');
    TestBed.configureTestingModule({ providers: [
      CheckoutLineEditorService,
      { provide: CatalogService, useValue: { getProduct: () => of({ variants: [{ variant_id: 'black-m', stock_quantity: 5, reserved_quantity: 4 }] }) } },
      { provide: CheckoutStore, useValue: checkout },
      { provide: CartStore, useValue: cart },
    ] });
    editor = TestBed.inject(CheckoutLineEditorService);
  });
  it('excludes reserved stock and rejects an over-limit edit without writing either store', () => {
    editor.choices('shirt').subscribe(choices => {
      expect(choices[0].available).toBe(1);
      expect(() => editor.edit(original, choices[0], 2, [original])).toThrow(/tồn kho/);
    });
    expect(checkout.setCheckoutItems).not.toHaveBeenCalled();
    expect(cart.replaceItems).not.toHaveBeenCalled();
  });
  it('merges a variant collision while preserving buy-now isolation from the cart', () => {
    const other = { ...original, variant_id: 'white-m', quantity: 2 };
    const next = editor.edit(original, { variant_id: 'white-m', available: 3, color: 'White', size: 'M' }, 1, [original, other]);
    expect(next).toHaveLength(1);
    expect(next[0].quantity).toBe(3);
    expect(other.quantity).toBe(2);
    expect(cart.replaceItems).not.toHaveBeenCalled();
    expect(checkout.setCheckoutItems).toHaveBeenCalledWith(next);
  });
  it('removes all combo components but keeps a separately selected variant of the same product', () => {
    const combo = { ...original, combo_id: 'set-1' };
    const part = { ...combo, variant_id: 'trousers-m' };
    cart.items.set([combo, part, original]);
    expect(editor.remove(combo, [combo, part, original])).toEqual([original]);
    expect(cart.replaceItems).toHaveBeenCalledWith([original]);
  });
  it('keeps an existing matching cart line unchanged when editing or removing a buy-now line', () => {
    checkout.source.set('buy_now');
    cart.items.set([original]);
    editor.edit(original, { variant_id: 'white-m', available: 3 }, 2, [original]);
    editor.remove(original, [original]);
    expect(cart.replaceItems).not.toHaveBeenCalled();
    expect(cart.items()).toEqual([original]);
  });
});
