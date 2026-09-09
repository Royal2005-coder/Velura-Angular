import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductSummary } from '../../core/models/product.interface';
import { CartStore } from '../../core/services/cart.store';
import { WishlistStore } from '../../core/services/wishlist.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';

@Component({
  selector: 'app-product-card',
  imports: [RouterLink],
  host: { style: 'display:block;height:100%' },
  templateUrl: './product-card.html',
})
export class ProductCard {
  private readonly wishlist = inject(WishlistStore);
  private readonly cart = inject(CartStore);
  private readonly router = inject(Router);
  readonly product = input.required<ProductSummary>();
  /** Catalog cards follow list.html badges; home keeps homepage.js colors. */
  readonly appearance = input<'home' | 'catalog'>('home');

  readonly imageUrl = computed(() =>
    toPublicAsset(this.product().images?.[0] || this.product().thumbnail_url, '/assets/images/placeholder.jpg'),
  );
  readonly price = computed(() => this.product().sale_price || this.product().base_price || 0);
  readonly oldPrice = computed(() => {
    const product = this.product();
    if (product.sale_price && product.base_price && product.base_price > product.sale_price) {
      return product.base_price;
    }
    return null;
  });
  readonly priceLabel = computed(() => formatVnd(this.price()));
  readonly oldPriceLabel = computed(() => formatVnd(this.oldPrice()));
  readonly discountPercent = computed(() => {
    const oldPrice = this.oldPrice();
    if (!oldPrice) {
      return 0;
    }
    return Math.round((1 - this.price() / oldPrice) * 100);
  });
  readonly isOutOfStock = computed(() => this.product().status === 'out_of_stock');
  readonly isCatalog = computed(() => this.appearance() === 'catalog');
  readonly excerpt = computed(() => (this.product().description || '').trim());
  readonly rating = computed(() => Number(this.product().rating_value || 0).toFixed(1));
  readonly saved = computed(() => this.wishlist.has(this.product().product_id));
  /**
   * Unique catalog color swatches from the original product variants.
   */
  readonly colorDots = computed(() => {
    const colors = new Map<string, string>();
    for (const variant of this.product().variants || []) {
      if (variant.color && !colors.has(variant.color)) {
        colors.set(variant.color, variant.color_hex || '#CCCCCC');
      }
    }
    return Array.from(colors, ([name, hex]) => ({ name, hex }));
  });

  /**
   * Toggles the original homepage wishlist heart without opening the product.
   */
  toggleWishlist(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.wishlist.toggle(this.product().product_id);
  }

  /**
   * Adds the first available variant using the original homepage cart button.
   */
  addToCart(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const product = this.product();
    if (product.status === 'out_of_stock') {
      showToast('Sản phẩm hiện đã hết hàng.');
      return;
    }
    const variant = product.variants?.[0];
    this.cart.addItem({
      variant_id: variant?.variant_id || product.product_id,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.imageUrl(),
      quantity: 1,
      unit_price: product.sale_price || product.base_price || 0,
      color: variant?.color,
      size: variant?.size,
    });
  }

  /**
   * Opens the original product detail page for the Buy Now CTA.
   */
  buyNow(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    void this.router.navigate(['/products', this.product().product_id]);
  }
}
