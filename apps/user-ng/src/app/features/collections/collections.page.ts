import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, UrlTree } from '@angular/router';
import { COLLECTION_LOOKBOOKS, CollectionLookbook, collectionCoverFraming } from '../../core/models/collection-lookbook';
import { ProductSummary } from '../../core/models/product.interface';
import { CartLine, CartStore } from '../../core/services/cart.store';
import { CatalogService } from '../../core/services/catalog.service';
import { CheckoutStore } from '../../core/services/checkout.store';
import { isExternalCmsLink, parseInternalCmsLink } from '../../core/utils/cms-link';
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly products = signal<ProductSummary[]>([]);
  readonly filter = signal('all');
  readonly lookbooks = signal<CollectionLookbook[]>(COLLECTION_LOOKBOOKS);

  readonly groups = computed(() => {
    const filter = this.filter();
    const availableLookbooks = this.lookbooks();
    const lookbooks = filter === 'all' ? availableLookbooks : availableLookbooks.filter((item) => item.id === filter);
    const productsById = new Map(this.products().map((row) => [row.product_id, row]));

    return lookbooks.map((lookbook, index) => ({
      lookbook,
      reverse: index % 2 === 1,
      // Combo/set được chọn tường minh trong CMS: giữ đúng thứ tự `productIds`, bỏ id không còn trong catalog.
      products: lookbook.productIds
        .map((id) => productsById.get(id))
        .filter((row): row is ProductSummary => row !== undefined),
    }));
  });

  constructor() {
    useBodyClass('page-collections');
    this.route.queryParamMap?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const requested = (params.get('collection') || '').trim();
      if (requested) {
        this.filter.set(requested);
      } else {
        const frag = this.route.snapshot?.fragment?.trim();
        this.filter.set(frag || 'all');
      }
    });
    this.route.fragment?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((frag) => {
      if (frag && !this.route.snapshot?.queryParamMap?.get('collection')) {
        this.filter.set(frag.trim());
      }
    });
    if (typeof this.catalog.getCollections === 'function') {
      this.catalog.getCollections().subscribe({
        next: (cols) => {
          if (cols && cols.length > 0) {
            this.lookbooks.set(cols);
          }
        },
      });
    }

    this.catalog.getProducts().subscribe({
      next: (rows) => {
        this.products.set(rows);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /**
   * Safely resolves a cutout model image by index with fallback to default cutout assets.
   */
  getModelCutout(lookbook: CollectionLookbook, index: number): string {
    const list = lookbook.models || [];
    if (list[index]) return list[index];
    const defaultModels = [
      '/assets/images/models/model_cutout_1.png',
      '/assets/images/models/model_cutout_2.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_4.png',
      '/assets/images/models/model_cutout_5.png',
    ];
    return defaultModels[index % defaultModels.length];
  }

  /**
   * Filters lookbooks using the original collection tabs and syncs the URL query param.
   */
  setFilter(id: string): void {
    this.filter.set(id);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { collection: id === 'all' ? null : id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Extracts the clean route path from a link string that may contain query parameters.
   */
  linkPath(url: string | null | undefined): string {
    if (!url) return '/products';
    return url.split('?')[0] || '/products';
  }

  /**
   * Parses query parameters from a link string so Angular Router does not percent-encode `?`.
   */
  linkQuery(url: string | null | undefined): Record<string, string> {
    if (!url || !url.includes('?')) return {};
    const params = new URLSearchParams(url.split('?')[1] || '');
    const out: Record<string, string> = {};
    params.forEach((value, key) => {
      out[key] = value;
    });
    return out;
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

  /** Checks whether a collection CTA URL points to an external HTTPS target. */
  isExternalLink(url: string | null | undefined): boolean {
    return isExternalCmsLink(url);
  }

  /** Parses an internal collection link into a `UrlTree` so query strings like `?category=dam-vay` stay intact. */
  cmsLink(url: string | null | undefined): UrlTree | string {
    return parseInternalCmsLink(this.router, url, '/products');
  }

  /** Computes cover framing (`object-position`, `transform-origin`, `transform`) matching Admin ERP cropper. */
  coverFraming(lookbook: CollectionLookbook): { objectPosition: string; transformOrigin: string; transform: string | null } {
    return collectionCoverFraming(lookbook);
  }

  /**
   * Two-digit index used by the original collection cards.
   */
  cardIndex(index: number): string {
    return String(index + 1).padStart(2, '0');
  }
}
