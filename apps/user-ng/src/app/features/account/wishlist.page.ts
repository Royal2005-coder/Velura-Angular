import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductSummary } from '../../core/models/product.interface';
import { CatalogService } from '../../core/services/catalog.service';
import { CartLine, CartStore } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { WishlistStore } from '../../core/services/wishlist.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-wishlist-page',
  imports: [RouterLink],
  host: { class: 'page-wishlist', style: 'display:block' },
  templateUrl: './wishlist.page.html',
})
export class WishlistPage {
  private readonly wishlist = inject(WishlistStore);
  private readonly catalog = inject(CatalogService);
  private readonly cart = inject(CartStore);
  private readonly checkout = inject(CheckoutStore);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly products = signal<ProductSummary[]>([]);
  readonly countLabel = computed(() => `Bạn đã lưu ${this.products().length} sản phẩm`);

  constructor() {
    useBodyClass('page-wishlist');
    this.catalog.getProducts().subscribe({
      next: (rows) => {
        const byId = new Map(rows.map((row) => [row.product_id, row]));
        this.products.set(
          this.wishlist
            .items()
            .map((item) => byId.get(item.product_id) || this.asSummary(item))
            .filter((item) => Boolean(item.product_id && item.name)),
        );
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /**
   * Public image helper for wishlist cards.
   */
  imageUrl(product: ProductSummary): string {
    return toPublicAsset(product.images?.[0] || product.thumbnail_url, '/assets/images/placeholder.jpg');
  }

  /**
   * Public sale price helper for wishlist cards.
   */
  priceLabel(product: ProductSummary): string {
    return formatVnd(product.sale_price || product.base_price);
  }

  /**
   * Public original price helper when a sale price is present.
   */
  oldPriceLabel(product: ProductSummary): string {
    if (!product.sale_price || !product.base_price || product.base_price <= product.sale_price) {
      return '';
    }
    return formatVnd(product.base_price);
  }

  /**
   * Removes a saved product using the original wishlist store.
   */
  remove(productId: string): void {
    this.wishlist.remove(productId);
    this.products.update((rows) => rows.filter((row) => row.product_id !== productId));
  }

  isOutOfStock(product: ProductSummary): boolean {
    if (product.status === 'out_of_stock') return true;
    const variants = product.variants || [];
    if (variants.length > 0) {
      const totalAvailable = variants.reduce(
        (sum, v) => sum + Math.max(0, (v.stock_quantity || 0) - (v.reserved_quantity || 0)),
        0,
      );
      return totalAvailable <= 0;
    }
    return false;
  }

  /**
   * Adds a saved product to the cart and displays confirmation toast.
   */
  addToCart(product: ProductSummary, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.isOutOfStock(product)) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return;
    }
    const variants = product.variants || [];
    const variant = variants.find((v) => ((v.stock_quantity ?? 1) - (v.reserved_quantity ?? 0)) > 0) || variants[0];
    this.cart.addItem({
      variant_id: variant?.variant_id || product.product_id,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.imageUrl(product),
      quantity: 1,
      unit_price: product.sale_price || product.base_price || 0,
      color: variant?.color,
      size: variant?.size,
    });
  }

  /**
   * Directly initiates checkout and navigates to /checkout/shipping.
   */
  buyNow(product: ProductSummary, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.isOutOfStock(product)) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return;
    }
    const variants = product.variants || [];
    const variant = variants.find((v) => ((v.stock_quantity ?? 1) - (v.reserved_quantity ?? 0)) > 0) || variants[0];
    const line: CartLine = {
      variant_id: variant?.variant_id || product.product_id,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.imageUrl(product),
      quantity: 1,
      unit_price: product.sale_price || product.base_price || 0,
      color: variant?.color,
      size: variant?.size,
    };
    this.checkout.setCheckoutItems([line], 'buy_now');
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl('/checkout/shipping');
  }

  /**
   * Shares the original wishlist URL via Web Share or clipboard.
   */
  shareList(): void {
    const shareUrl = window.location.href;
    if (navigator.share) {
      void navigator.share({
        title: 'Danh sách sản phẩm yêu thích của tôi tại Velura Store',
        url: shareUrl,
      });
      return;
    }
    void navigator.clipboard.writeText(shareUrl).then(
      () => showToast('Đã sao chép liên kết danh sách yêu thích vào bộ nhớ tạm!'),
      () => showToast('Không thể sao chép liên kết'),
    );
  }

  private asSummary(item: { product_id: string; name: string; thumbnail_url?: string | null; images?: string[]; base_price?: number; sale_price?: number | null }): ProductSummary {
    return {
      product_id: item.product_id,
      name: item.name,
      thumbnail_url: item.thumbnail_url,
      images: item.images,
      base_price: item.base_price,
      sale_price: item.sale_price,
    };
  }
}
