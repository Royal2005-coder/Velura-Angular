import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ProductSummary } from '../models/product.interface';
import { ApiService } from './api.service';
import { CATALOG_SHARE_WINDOW_MS, CatalogService } from './catalog.service';

describe('CatalogService', () => {
  const renamed: ProductSummary = { product_id: 'p1', name: 'Premium Cotton 100%' };
  const original: ProductSummary = { product_id: 'p1', name: 'Áo thun basic' };
  const get = vi.fn();
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    get.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get } }] });
  });

  it('shares one download inside the window, then refetches so an admin rename is not frozen for the session', async () => {
    get.mockReturnValueOnce(of([original])).mockReturnValueOnce(of([renamed]));
    const catalog = TestBed.inject(CatalogService);

    expect((await firstValueFrom(catalog.getProducts()))[0].name).toBe('Áo thun basic');
    expect((await firstValueFrom(catalog.getProducts()))[0].name).toBe('Áo thun basic');
    expect(get).toHaveBeenCalledTimes(1);

    now += CATALOG_SHARE_WINDOW_MS + 1;
    expect((await firstValueFrom(catalog.getProducts()))[0].name).toBe('Premium Cotton 100%');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failed download', async () => {
    get.mockReturnValueOnce(throwError(() => new Error('mất kết nối'))).mockReturnValueOnce(of([renamed]));
    const catalog = TestBed.inject(CatalogService);

    await expect(firstValueFrom(catalog.getProducts())).rejects.toThrow('mất kết nối');
    expect((await firstValueFrom(catalog.getProducts()))[0].name).toBe('Premium Cotton 100%');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
