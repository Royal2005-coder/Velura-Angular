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
import { matchesSearchText } from '../../core/utils/search';

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
  readonly recentlyViewed = signal<ProductSummary[]>([]);

  readonly quickCategories = [
    { name: 'Đầm & Váy', slug: 'dam-vay', image: '/assets/images/category-icons/icon-dam-vay.png' },
    { name: 'Set đồ & Combo', slug: 'set-do', image: '/assets/images/category-icons/icon-set-do.png' },
    { name: 'Áo kiểu & Sơ mi', slug: 'ao', image: '/assets/images/category-icons/icon-ao.png' },
    { name: 'Quần & Jeans', slug: 'quan', image: '/assets/images/category-icons/icon-quan.png' },
    { name: 'Áo khoác & Blazer', slug: 'ao-khoac', image: '/assets/images/category-icons/icon-ao-khoac.png' },
    { name: 'Giày dép', slug: 'giay-dep', image: '/assets/images/category-icons/icon-giay-dep.png' },
    { name: 'Phụ kiện', slug: 'phu-kien', image: '/assets/images/category-icons/icon-phu-kien.png' },
  ];

  readonly trendingKeywords = [
    'Áo thun',
    'Quần Shorts',
    'Áo Polo',
    'Đầm dạ hội',
    'Set đồ mùa thu',
    'Chân váy xếp ly',
    'Áo khoác chống nắng',
    'Quần dài',
  ];

  readonly instantSuggestions = computed(() => {
    const q = this.searchQuery().trim();
    if (q.length < 2) return [];
    return this.allProducts()
      .filter((p) => {
        const nameMatch = matchesSearchText(p.name, q);
        const tagMatch = p.style_tags?.some((t) => matchesSearchText(t, q));
        const colorMatch = matchesSearchText(p.color_tone, q);
        const catMatch = matchesSearchText(p.category_name, q);
        return nameMatch || tagMatch || colorMatch || catMatch;
      })
      .slice(0, 6);
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
    this.loadRecentlyViewed();
  }

  loadRecentlyViewed(): void {
    try {
      const raw = localStorage.getItem('velura_recently_viewed');
      if (raw) {
        this.recentlyViewed.set(JSON.parse(raw) as ProductSummary[]);
      } else {
        this.recentlyViewed.set([]);
      }
    } catch {
      this.recentlyViewed.set([]);
    }
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
  /**
   * Handles form submission from pressing Enter or clicking search button.
   */
  onSearchSubmit(event: Event): void {
    event.preventDefault();
    this.executeSearch(this.searchQuery());
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
