import { Injectable, inject } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';
import { CategorySummary, ProductSummary } from '../models/product.interface';
import { ApiService } from './api.service';

/**
 * Product catalog model. UI must bind signals in the page ViewModel, not this service.
 */
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly api = inject(ApiService);
  private readonly products$ = this.api
    .get<ProductSummary[]>('/api/user/products')
    .pipe(shareReplay({ bufferSize: 1, refCount: false }));
  private readonly categories$ = this.api
    .get<CategorySummary[]>('/api/user/categories')
    .pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /**
   * Loads storefront categories.
   */
  getCategories(): Observable<CategorySummary[]> {
    return this.categories$;
  }

  /**
   * Loads the storefront catalog, including variants used by add-to-cart.
   */
  getProducts(): Observable<ProductSummary[]> {
    return this.products$;
  }

  /**
   * Loads one product with variants for the detail ViewModel.
   */
  getProduct(productId: string): Observable<ProductSummary> {
    return this.api.get<ProductSummary>(`/api/user/products/${productId}`);
  }
}
