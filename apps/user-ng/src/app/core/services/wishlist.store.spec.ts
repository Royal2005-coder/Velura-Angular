import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { WishlistStore } from './wishlist.store';

describe('WishlistStore guest tab isolation', () => {
  const configure = (): WishlistStore => {
    TestBed.configureTestingModule({
      providers: [
        WishlistStore,
        { provide: ApiService, useValue: { get: vi.fn(() => of({ items: [] })), post: vi.fn(), delete: vi.fn() } },
      ],
    });
    return TestBed.inject(WishlistStore);
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('never imports a browser-global wishlist from an older guest', () => {
    localStorage.setItem('velura_guest_wishlist', JSON.stringify(['old-product']));

    const wishlist = configure();

    expect(wishlist.items()).toEqual([]);
    expect(localStorage.getItem('velura_guest_wishlist')).toBeNull();
  });

  it('starts empty after the previous guest tab session ends', () => {
    const first = configure();
    first.toggle('product-a');
    expect(first.has('product-a')).toBe(true);

    TestBed.resetTestingModule();
    sessionStorage.clear();
    const next = configure();

    expect(next.items()).toEqual([]);
  });
});
