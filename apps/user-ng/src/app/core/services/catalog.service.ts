import { Injectable, inject } from '@angular/core';
import { Observable, catchError, shareReplay, throwError } from 'rxjs';
import { CategorySummary, ProductSummary } from '../models/product.interface';
import { ApiService } from './api.service';

/**
 * How long one catalog download is shared between the header, list, home and detail pages of the
 * same navigation. Any later navigation refetches, so an admin rename, status or stock change
 * shows up on the next page view instead of staying frozen for the whole SPA session.
 */
export const CATALOG_SHARE_WINDOW_MS = 5_000;

interface SharedRequest<T> {
  stream: Observable<T>;
  loadedAt: number;
}

/**
 * Product catalog model. UI must bind signals in the page ViewModel, not this service.
 */
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly api = inject(ApiService);
  private products: SharedRequest<ProductSummary[]> | null = null;
  private categories: SharedRequest<CategorySummary[]> | null = null;

  /**
   * Loads storefront categories.
   */
  getCategories(): Observable<CategorySummary[]> {
    this.categories = this.fresh(this.categories, '/api/user/categories', () => (this.categories = null));
    return this.categories.stream;
  }

  /**
   * Loads the storefront catalog, including variants used by add-to-cart.
   * The download is shared only for {@link CATALOG_SHARE_WINDOW_MS}; a failed download is never cached.
   */
  getProducts(): Observable<ProductSummary[]> {
    this.products = this.fresh(this.products, '/api/user/products', () => (this.products = null));
    return this.products.stream;
  }

  /**
   * Loads one product with variants for the detail ViewModel.
   */
  getProduct(productId: string): Observable<ProductSummary> {
    return this.api.get<ProductSummary>(`/api/user/products/${productId}`);
  }

  /**
   * Toggles helpful heart count on a verified product review.
   */
  likeReview(reviewId: string, liked: boolean): Observable<{ success: boolean; review_id: string; helpful_count: number }> {
    return this.api.post<{ success: boolean; review_id: string; helpful_count: number }>(
      `/api/user/reviews/${encodeURIComponent(reviewId)}/like`,
      { liked },
    );
  }

  private fresh<T>(current: SharedRequest<T> | null, path: string, reset: () => void): SharedRequest<T> {
    if (current && Date.now() - current.loadedAt < CATALOG_SHARE_WINDOW_MS) {
      return current;
    }
    const stream = this.api.get<T>(path).pipe(
      catchError((error: unknown) => {
        reset();
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return { stream, loadedAt: Date.now() };
  }
}
