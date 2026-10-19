import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { sampleProduct } from '../../../testing/storefront-testing';
import { CatalogService } from './catalog.service';

describe('CatalogService freshness', () => {
  it('fetches the renamed product instead of replaying the first session response', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const catalog = TestBed.inject(CatalogService);
    const http = TestBed.inject(HttpTestingController);
    const names: string[] = [];
    catalog.getProducts().subscribe(rows => names.push(rows[0].name));
    http.expectOne(req => req.url.endsWith('/api/user/products')).flush([{ ...sampleProduct, name: 'UAT-Khai Áo Thun Basic' }]);
    catalog.getProducts().subscribe(rows => names.push(rows[0].name));
    http.expectOne(req => req.url.endsWith('/api/user/products')).flush([{ ...sampleProduct, name: 'UAT-Khai Áo Thun Premium Cotton 100%' }]);
    expect(names).toEqual(['UAT-Khai Áo Thun Basic', 'UAT-Khai Áo Thun Premium Cotton 100%']);
    http.verify();
  });
});
