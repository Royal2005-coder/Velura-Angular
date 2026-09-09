import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, of } from 'rxjs';
import { ApiService } from './api.service';

const GUEST_KEY = 'velura_guest_wishlist';
const COUNT_KEY = 'velura_wishlist_count';

export interface WishlistItem {
  product_id: string;
  name: string;
  thumbnail_url?: string | null;
  images?: string[];
  base_price?: number;
  sale_price?: number | null;
}

/**
 * Wishlist badge and guest/member lists. Uses the same localStorage keys as vanilla.
 */
@Injectable({ providedIn: 'root' })
export class WishlistStore {
  private readonly api = inject(ApiService);

  readonly items = signal<WishlistItem[]>([]);
  readonly itemCount = computed(() => this.items().length);

  constructor() {
    this.refresh();
  }

  /**
   * Reloads wishlist count from guest storage or the member API.
   */
  refresh(): void {
    const token = localStorage.getItem('velura_token');
    if (!token) {
      const ids = this.readGuestIds();
      this.items.set(ids.map((product_id) => ({ product_id, name: '' })));
      return;
    }
    this.api
      .get<{ items?: WishlistItem[] }>('/api/user/wishlist')
      .pipe(catchError(() => of({ items: [] as WishlistItem[] })))
      .subscribe((data) => {
        const items = data.items || [];
        this.items.set(items);
        localStorage.setItem(COUNT_KEY, String(items.length));
      });
  }

  /**
   * Returns whether a product is already saved.
   */
  has(productId: string): boolean {
    return this.items().some((item) => item.product_id === productId);
  }

  /**
   * Adds or removes a product using the original wishlist API / guest key.
   */
  toggle(productId: string): void {
    const token = localStorage.getItem('velura_token');
    if (!token) {
      const ids = this.readGuestIds();
      const next = ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId];
      localStorage.setItem(GUEST_KEY, JSON.stringify(next));
      this.items.set(next.map((product_id) => ({ product_id, name: '' })));
      return;
    }
    if (this.has(productId)) {
      this.api.delete<unknown>(`/api/user/wishlist?product_id=${productId}`).subscribe({
        next: () => this.refresh(),
        error: () => this.refresh(),
      });
      return;
    }
    this.api.post<unknown>('/api/user/wishlist', { product_id: productId }).subscribe({
      next: () => this.refresh(),
      error: () => this.refresh(),
    });
  }

  /**
   * Removes a saved product from the current wishlist.
   */
  remove(productId: string): void {
    if (!this.has(productId)) {
      return;
    }
    this.toggle(productId);
  }

  private readGuestIds(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(GUEST_KEY) || '[]') as unknown;
      return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
    } catch {
      return [];
    }
  }
}
