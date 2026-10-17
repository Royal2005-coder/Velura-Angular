import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { UserSession } from '../models/user-session.interface';
import { guestSessionId, rotateGuestSession } from '../utils/guest-session';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { CartStore, type CartLine } from './cart.store';

const line = (variantId: string): CartLine => ({
  variant_id: variantId,
  product_id: `product-${variantId}`,
  product_name: variantId,
  product_image: '',
  quantity: 1,
  unit_price: 100000,
});

const member = (userId: string): UserSession => ({
  userId, email: null, fullName: null, phone: null, avatarUrl: null,
});

describe('CartStore identity isolation', () => {
  const session = signal<UserSession | null>(null);
  const get = vi.fn();
  const post = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    session.set(null);
    get.mockReset();
    post.mockReset();
    get.mockReturnValue(of({ success: true, items: [] }));
    post.mockImplementation((_path: string, body: { items: CartLine[] }) => of({ success: true, items: body.items }));
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } },
      { provide: ApiService, useValue: { get, post } },
    ] });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('never imports the old browser-global cart into a new guest session', () => {
    localStorage.setItem('velura_cart', JSON.stringify([line('legacy')]));
    const cart = TestBed.inject(CartStore);
    TestBed.flushEffects();

    expect(cart.items()).toEqual([]);
    expect(localStorage.getItem('velura_cart')).toBeNull();
  });

  it('keeps each member server cart separate and returns to an empty new guest on logout', () => {
    const firstGuestId = guestSessionId();
    const cart = TestBed.inject(CartStore);
    TestBed.flushEffects();
    cart.addItem(line('guest-old'), { silent: true });
    expect(cart.items().map((item) => item.variant_id)).toEqual(['guest-old']);

    get.mockReturnValueOnce(of({ success: true, items: [line('member-a')] }));
    session.set(member('A'));
    TestBed.flushEffects();
    expect(cart.items().map((item) => item.variant_id)).toEqual(['member-a']);

    get.mockReturnValueOnce(of({ success: true, items: [line('member-b')] }));
    session.set(member('B'));
    TestBed.flushEffects();
    expect(cart.items().map((item) => item.variant_id)).toEqual(['member-b']);

    rotateGuestSession();
    session.set(null);
    TestBed.flushEffects();
    expect(guestSessionId()).not.toBe(firstGuestId);
    expect(cart.items()).toEqual([]);
  });

  it('writes member mutations only through the authenticated cart endpoint', () => {
    session.set(member('A'));
    const cart = TestBed.inject(CartStore);
    TestBed.flushEffects();
    post.mockClear();

    cart.addItem(line('member-a-new'), { silent: true });

    expect(post).toHaveBeenCalledWith('/api/user/cart', { items: [line('member-a-new')] });
    expect(sessionStorage.getItem(`velura_cart:member:A`)).toBeNull();
  });
});
