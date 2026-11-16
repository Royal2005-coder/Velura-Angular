import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { CategorySummary, ProductSummary } from '../models/product.interface';
import { BannerSummary } from '../models/banner.interface';
import { COLLECTION_LOOKBOOKS, CollectionLookbook, normalizeCollectionLookbook } from '../models/collection-lookbook';
import { ApiService } from './api.service';

/**
 * Product catalog model. UI must bind signals in the page ViewModel, not this service.
 */
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly api = inject(ApiService);

  /**
   * Loads storefront categories.
   */
  getCategories(): Observable<CategorySummary[]> {
    return this.api.get<CategorySummary[]>('/api/user/categories');
  }

  /**
   * Loads current catalog data so admin edits are visible on the next storefront interaction.
   */
  getProducts(): Observable<ProductSummary[]> {
    return this.api.get<ProductSummary[]>('/api/user/products');
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

  /**
   * Loads active dynamic banners for storefront hero placements.
   */
  getBanners(placement?: string): Observable<BannerSummary[]> {
    const query = placement ? `?placement=${encodeURIComponent(placement)}` : '';
    return this.api.get<{ success: boolean; data: BannerSummary[] }>(`/api/v1/banners${query}`).pipe(
      map((res) => res?.data || []),
      catchError(() => of([])),
    );
  }

  /**
   * Loads active seasonal fashion collections and lookbook models.
   */
  getCollections(): Observable<CollectionLookbook[]> {
    return this.api.get<{ success: boolean; data: any[] }>('/api/v1/collections').pipe(
      map((res) => {
        if (!res?.data || !res.data.length) return COLLECTION_LOOKBOOKS;
        return res.data.map(normalizeCollectionLookbook);
      }),
      catchError(() => of(COLLECTION_LOOKBOOKS)),
    );
  }
}
