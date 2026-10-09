import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CartStore } from '../../core/services/cart.store';
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
  imports: [RouterLink, RouterLinkActive, VisualSearchWorkbench],
  templateUrl: './site-header.html',
})
export class SiteHeader {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);

  readonly isLoggedIn = this.auth.isLoggedIn;
  readonly displayName = computed(() => this.auth.session()?.fullName || this.auth.session()?.email || 'Tài khoản');
  readonly avatarUrl = computed(() => this.auth.session()?.avatarUrl);
  readonly cartCount = this.cart.itemCount;
  readonly wishlistCount = this.wishlist.itemCount;
  readonly navOpen = signal(false);

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
    // Empty ids handled by onVisualSearchResult category fallback
  }

  /**
   * Routes visual search results: if no similarity matches found but a category was detected,
   * falls back to navigating to the detected category page instead of an empty product list.
   */
  onVisualSearchResult(result: VisualResult): void {
    if (result.matches.length > 0) return; // matches route handled by onVisualSearchMatches
    const category = result.attributes.category?.toLowerCase().trim();
    if (category) {
      const slug = CATEGORY_QUERY_MAP[category] || category;
      void this.router.navigate(['/products'], { queryParams: { category: slug } });
    } else {
      void this.router.navigate(['/products'], { queryParams: { match_ids: '' } });
    }
  }

  /**
   * Runs the original header search against the product catalog.
   */
  onSearch(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (event instanceof KeyboardEvent && event.key !== 'Enter') {
      return;
    }
    const query = input.value.trim();
    void this.router.navigate(['/products'], { queryParams: query ? { q: query } : {} });
  }
}
