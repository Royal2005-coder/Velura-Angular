import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { ApiService } from '../../core/services/api.service';
import { CartComboSubItem, CartLine, CartStore } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
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
  private readonly checkout = inject(CheckoutStore);
  private readonly api = inject(ApiService);
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
  readonly isOutOfStock = computed(() => {
    const p = this.product();
    if (p.status === 'out_of_stock') return true;
    const variants = p.variants || [];
    if (variants.length > 0) {
      const totalAvailable = variants.reduce(
        (sum, v) => sum + Math.max(0, (v.stock_quantity || 0) - (v.reserved_quantity || 0)),
        0,
      );
      return totalAvailable <= 0;
    }
    return false;
  });
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
   * Quick adds the first available variant to the cart and notifies the customer.
   */
  async addToCart(event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const line = await this.resolveCartLine();
    if (!line) {
      return;
    }
    this.cart.addItem(line);
  }

  /**
   * Immediately initiates checkout with the product and navigates to /checkout/shipping.
   */
  async buyNow(event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const line = await this.resolveCartLine();
    if (!line) {
      return;
    }
    this.checkout.setCheckoutItems([line], 'buy_now');
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl('/checkout/shipping');
  }

  private async resolveCartLine(): Promise<CartLine | null> {
    const product = this.product();
    if (this.isOutOfStock()) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return null;
    }

    if (product.is_combo) {
      let components = product.combo_components;
      let comboVariants = product.variants;
      if (!components || components.length === 0) {
        try {
          const detail = await firstValueFrom(this.api.get<ProductSummary>(`/api/user/products/${product.product_id}`));
          components = detail?.combo_components;
          comboVariants = detail?.variants || comboVariants;
        } catch {
          // fallback to current product data
        }
      }

      const comboVariant = comboVariants?.[0];
      const comboVariantId = comboVariant?.variant_id || product.product_id;
      const comboPrice = product.sale_price || product.base_price || 0;
      const comboId = `combo-${product.product_id}-${Date.now()}`;

      const subItems: CartComboSubItem[] = (components || []).map((component) => {
        const v = (component.variants || []).find((cv) => ((cv.stock_quantity ?? 1) - (cv.reserved_quantity ?? 0)) > 0) || component.variants?.[0];
        return {
          product_id: component.product_id,
          product_name: component.name,
          product_image: toPublicAsset(component.images?.[0], '/assets/images/placeholder.jpg'),
          variant_id: v?.variant_id || component.product_id,
          color: v?.color || '',
          size: v?.size || '',
          quantity: Math.max(1, component.quantity || 1),
          available_variants: (component.variants || []).map((cv) => ({
            variant_id: cv.variant_id,
            color: cv.color,
            size: cv.size,
            stock_quantity: cv.stock_quantity,
            reserved_quantity: cv.reserved_quantity,
          })),
        };
      });

      return {
        variant_id: comboVariantId,
        product_id: product.product_id,
        product_name: product.name,
        product_image: this.imageUrl(),
        quantity: 1,
        unit_price: comboPrice,
        is_combo: true,
        sub_items: subItems.length > 0 ? subItems : undefined,
        combo_id: comboId,
        combo_name: product.name,
        combo_price: comboPrice,
        combo_image: this.imageUrl(),
      };
    }

    const variants = product.variants || [];
    const variant = variants.find((v) => ((v.stock_quantity ?? 1) - (v.reserved_quantity ?? 0)) > 0) || variants[0];

    return {
      variant_id: variant?.variant_id || product.product_id,
      product_name: product.name,
      product_id: product.product_id,
      product_image: this.imageUrl(),
      quantity: 1,
      unit_price: product.sale_price || product.base_price || 0,
      color: variant?.color,
      size: variant?.size,
    };
  }
}
