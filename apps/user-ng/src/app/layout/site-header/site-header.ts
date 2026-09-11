import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CartStore } from '../../core/services/cart.store';
import { WishlistStore } from '../../core/services/wishlist.store';

@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive],
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
