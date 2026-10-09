import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import type { ProductSummary } from '../../core/models/product.interface';
import { AuthService } from '../../core/services/auth.service';
import { CartStore } from '../../core/services/cart.store';
import { CatalogService } from '../../core/services/catalog.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import type { VisualResult } from '../../core/services/visual-search.service';
import { VisualSearchWorkbench } from '../../shared/visual-search-workbench/visual-search-workbench';

/** Maps Gemini Vision detected categories to Velura catalog slugs for routing. */
const CATEGORY_QUERY_MAP: Record<string, string> = {
  top: 'ao', blouse: 'ao', shirt: 'ao', tshirt: 'ao',
  pants: 'quan', trousers: 'quan', jeans: 'quan',
  dress: 'dam-vay', skirt: 'dam-vay',
  jacket: 'ao-khoac', coat: 'ao-khoac', blazer: 'ao-khoac',
  set: 'set-do', suit: 'set-do',
  accessories: 'phu-kien', bag: 'phu-kien', hat: 'phu-kien', scarf: 'phu-kien',
  shoes: 'giay-dep', sandals: 'giay-dep', boots: 'giay-dep', sneakers: 'giay-dep',
};

@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive, DecimalPipe, VisualSearchWorkbench],
  templateUrl: './site-header.html',
})
export class SiteHeader {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);
  private readonly catalog = inject(CatalogService);
  private readonly destroy = inject(DestroyRef);

  readonly isLoggedIn = this.auth.isLoggedIn;
  readonly displayName = computed(() => this.auth.session()?.fullName || this.auth.session()?.email || 'Tài khoản');
  readonly avatarUrl = computed(() => this.auth.session()?.avatarUrl);
  readonly cartCount = this.cart.itemCount;
  readonly wishlistCount = this.wishlist.itemCount;
  readonly navOpen = signal(false);

  // Search dropdown states
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  readonly allProducts = signal<ProductSummary[]>([]);

  readonly quickCategories = [
    { name: 'Đầm & Váy', slug: 'dam-vay' },
    { name: 'Set đồ & Combo', slug: 'set-do' },
    { name: 'Áo kiểu & Sơ mi', slug: 'ao' },
    { name: 'Quần & Jeans', slug: 'quan' },
    { name: 'Áo khoác & Blazer', slug: 'ao-khoac' },
    { name: 'Giày dép thời trang', slug: 'giay-dep' },
    { name: 'Phụ kiện cao cấp', slug: 'phu-kien' },
  ];

  readonly trendingKeywords = [
    'Set đồ mùa thu',
    'Đầm dạ hội',
    'Áo tweed croptop',
    'Chân váy xếp ly',
    'Linen dạo biển',
    'Blazer công sở',
  ];

  readonly instantSuggestions = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length < 2) return [];
    return this.allProducts()
      .filter((p) => {
        const nameMatch = p.name.toLowerCase().includes(q);
        const tagMatch = p.style_tags?.some((t) => t.toLowerCase().includes(q));
        const colorMatch = p.color_tone?.toLowerCase().includes(q);
        return nameMatch || tagMatch || colorMatch;
      })
      .slice(0, 5);
  });

  constructor() {
    this.catalog
      .getProducts()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (products) => this.allProducts.set(products),
        error: () => this.allProducts.set([]),
      });
  }

  /**
   * Toggles the mobile navigation drawer.
   */
  toggleNav(): void {
    this.navOpen.update((open) => !open);
  }

  /**
   * Signs the member out and returns header to guest actions.
   */
  logout(): void {
    this.auth.signOut();
  }

  readonly headerWorkbench = viewChild<VisualSearchWorkbench>('headerWorkbench');

  /**
   * Opens the AI visual image search workbench modal.
   */
  openVisualSearch(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.searchOpen.set(false);
    this.headerWorkbench()?.open();
  }

  /**
   * Routes visual search vector matches to the catalog product list.
   */
  onVisualSearchMatches(ids: string[]): void {
    if (ids.length) {
      void this.router.navigate(['/products'], {
        queryParams: { match_ids: ids.join(',') },
      });
    }
  }

  /**
   * Routes visual search results: if no similarity matches found but a category was detected,
   * falls back to navigating to the detected category page instead of an empty product list.
   */
  onVisualSearchResult(result: VisualResult): void {
    if (result.matches.length > 0) return;
    const category = result.attributes.category?.toLowerCase().trim();
    if (category) {
      const slug = CATEGORY_QUERY_MAP[category] || category;
      void this.router.navigate(['/products'], { queryParams: { category: slug } });
    } else {
      void this.router.navigate(['/products'], { queryParams: { match_ids: '' } });
    }
  }

  onSearchFocus(): void {
    this.searchOpen.set(true);
  }

  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
    this.searchOpen.set(true);
  }

  selectKeyword(keyword: string): void {
    this.searchQuery.set(keyword);
    this.searchOpen.set(false);
    void this.router.navigate(['/products'], { queryParams: { q: keyword } });
  }

  selectCategory(slug: string): void {
    this.searchOpen.set(false);
    void this.router.navigate(['/products'], { queryParams: { category: slug } });
  }

  selectProduct(slug?: string): void {
    if (!slug) return;
    this.searchOpen.set(false);
    void this.router.navigate(['/products', slug]);
  }

  executeSearch(query: string): void {
    const trimmed = query.trim();
    this.searchOpen.set(false);
    void this.router.navigate(['/products'], { queryParams: trimmed ? { q: trimmed } : {} });
  }

  closeSearch(): void {
    this.searchOpen.set(false);
  }

  /**
   * Runs the original header search against the product catalog on Enter.
   */
  onSearch(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (event instanceof KeyboardEvent && event.key !== 'Enter') {
      if (event.key === 'Escape') {
        this.closeSearch();
      }
      return;
    }
    const query = input.value.trim();
    this.executeSearch(query);
  }
}
