import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { createStorefrontPage, sampleProduct, stubApiService } from '../../../testing/storefront-testing';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { CatalogService } from '../../core/services/catalog.service';
import { ProductListPage } from './product-list.page';

describe('ProductListPage', () => {
  it('reloads a reused search route after an admin rename and can recover after a failed read', () => {
    const params = new BehaviorSubject(convertToParamMap({}));
    const renamed = { ...sampleProduct, name: 'UAT-Khai Áo Thun Premium Cotton 100%' };
    const getProducts = vi.fn()
      .mockReturnValueOnce(of([{ ...sampleProduct, name: 'UAT-Khai Áo Thun Basic' }]))
      .mockReturnValueOnce(throwError(() => new Error('Temporary catalog failure')))
      .mockReturnValueOnce(of([renamed]));
    TestBed.configureTestingModule({ providers: [
      provideRouter([]),
      { provide: ApiService, useValue: stubApiService() },
      { provide: AuthService, useValue: { isLoggedIn: signal(false) } },
      { provide: CatalogService, useValue: { getProducts } },
      { provide: ActivatedRoute, useValue: { queryParamMap: params } },
    ] });
    const page = TestBed.runInInjectionContext(() => new ProductListPage());
    params.next(convertToParamMap({ q: 'Premium Cotton 100%' }));
    expect(page.loadError()).toBe('Temporary catalog failure');
    params.next(convertToParamMap({ q: 'Premium Cotton 100%', category: 'ao' }));
    expect(getProducts).toHaveBeenCalledTimes(3);
    expect(page.loadError()).toBe('');
    expect(page.loading()).toBe(false);
    expect(page.allProducts()[0].name).toBe(renamed.name);
    expect(page.productCount()).toBe(1);
  });
  it('keeps visual candidates based on catalog filters independently of previous image matches', async () => {
    const page = await createStorefrontPage(ProductListPage);
    const originalIds = page.imageSearchCandidates();
    expect(originalIds.length).toBe(1);
    page.applyImageMatches([]);
    expect(page.productCount()).toBe(0);
    expect(page.imageSearchCandidates()).toEqual(originalIds);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.imageSearchCandidates()).toEqual([]);
  });
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page).toBeTruthy();
  });

  it('keeps filter state on signals — template must not call .filter()', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page.loading()).toBe(false);
    expect(page.productCount()).toBe(1);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.productCount()).toBe(0);
    page.searchQuery.set('linen');
    expect(page.productCount()).toBe(1);
    expect(page.activeCategoryLabel()).toContain('linen');
  });

  it('displays and clears active promotional voucher code', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page.activeVoucherCode()).toBeNull();

    page.activeVoucherCode.set('FALL10');
    expect(page.activeVoucherCode()).toBe('FALL10');

    page.clearActiveVoucher();
    expect(page.activeVoucherCode()).toBeNull();
    expect(localStorage.getItem('checkout_voucher_code')).toBeNull();
  });
});
