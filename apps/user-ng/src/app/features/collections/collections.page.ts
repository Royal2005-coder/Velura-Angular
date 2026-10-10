import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { COLLECTION_LOOKBOOKS } from '../../core/models/collection-lookbook';
import { ProductSummary } from '../../core/models/product.interface';
import { CartLine, CartStore } from '../../core/services/cart.store';
import { CatalogService } from '../../core/services/catalog.service';
import { CheckoutStore } from '../../core/services/checkout.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { showToast } from '../../core/utils/toast';

@Component({
  selector: 'app-collections-page',
  imports: [RouterLink],
  host: { class: 'page-collections' },
  templateUrl: './collections.page.html',
})
export class CollectionsPage {
  private readonly catalog = inject(CatalogService);
  private readonly cart = inject(CartStore);
  private readonly checkout = inject(CheckoutStore);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly products = signal<ProductSummary[]>([]);
  readonly filter = signal('all');
  readonly lookbooks = COLLECTION_LOOKBOOKS;

  readonly groups = computed(() => {
    const filter = this.filter();
    const lookbooks = filter === 'all' ? this.lookbooks : this.lookbooks.filter((item) => item.id === filter);
    return lookbooks.map((lookbook, index) => ({
      lookbook,
      reverse: index % 2 === 1,
      products: this.products().filter((row) => row.collection === lookbook.name),
    }));
  });

  constructor() {
    useBodyClass('page-collections');
    this.catalog.getProducts().subscribe({
      next: (rows) => {
        this.products.set(rows.filter((row) => row.is_combo && row.collection));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /**
   * Filters lookbooks using the original collection tabs.
   */
  setFilter(id: string): void {
    this.filter.set(id);
  }

  /**
   * Public asset helper for collection cards.
   */
  imageUrl(product: ProductSummary): string {
    return toPublicAsset(product.images?.[0] || product.thumbnail_url, '/assets/images/placeholder.jpg');
  }

  /**
   * Public price helper for collection cards.
   */
  priceLabel(product: ProductSummary): string {
    return formatVnd(product.sale_price || product.base_price);
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
   * Adds a combo look to the cart and displays confirmation toast.
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
   * Two-digit index used by the original collection cards.
   */
  cardIndex(index: number): string {
    return String(index + 1).padStart(2, '0');
  }
}
