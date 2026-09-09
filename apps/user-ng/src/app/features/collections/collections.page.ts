import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { COLLECTION_LOOKBOOKS } from '../../core/models/collection-lookbook';
import { ProductSummary } from '../../core/models/product.interface';
import { CartStore } from '../../core/services/cart.store';
import { CatalogService } from '../../core/services/catalog.service';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-collections-page',
  imports: [RouterLink],
  host: { class: 'page-collections' },
  templateUrl: './collections.page.html',
})
export class CollectionsPage {
  private readonly catalog = inject(CatalogService);
  private readonly cart = inject(CartStore);

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

  /**
   * Adds a combo look to the original cart payload.
   */
  addToCart(product: ProductSummary): void {
    const variant = product.variants?.[0];
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
   * Two-digit index used by the original collection cards.
   */
  cardIndex(index: number): string {
    return String(index + 1).padStart(2, '0');
  }
}
