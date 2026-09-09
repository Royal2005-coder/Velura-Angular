import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProductSummary } from '../../core/models/product.interface';
import { CatalogService } from '../../core/services/catalog.service';
import { CartStore } from '../../core/services/cart.store';
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

  /**
   * Adds a saved product to the original cart payload.
   */
  addToCart(product: ProductSummary): void {
    this.cart.addItem({
      variant_id: product.variants?.[0]?.variant_id || product.product_id,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.imageUrl(product),
      quantity: 1,
      unit_price: product.sale_price || product.base_price || 0,
      color: product.variants?.[0]?.color,
      size: product.variants?.[0]?.size,
    });
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
