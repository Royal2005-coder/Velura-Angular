import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ComboComponent,
  ProductColorOption,
  ProductSummary,
  ProductVariant,
} from '../../core/models/product.interface';
import { CartLine } from '../../core/services/cart.store';
import { AuthService } from '../../core/services/auth.service';
import { CartStore } from '../../core/services/cart.store';
import { CatalogService } from '../../core/services/catalog.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import { useBodyClass } from '../../core/utils/body-class';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { ProductCard } from '../../shared/product-card/product-card';

interface ComboPick {
  productId: string;
  color: string;
  size: string;
}

interface SpecRow {
  label: string;
  value: string;
}

interface ProductBadge {
  kind: 'sale' | 'hot' | 'new' | 'combo' | 'stock';
  label: string;
}

const TONE_MAP: Record<string, string> = {
  Warm: 'Ấm áp',
  Cool: 'Mát mẻ',
  Neutral: 'Trung tính',
};

const OCCASION_MAP: Record<string, string> = {
  Party: 'Dự tiệc',
  Casual: 'Thường ngày',
  Office: 'Công sở',
  Travel: 'Du lịch',
  Wedding: 'Đám cưới',
  School: 'Đi học',
};

const SHAPE_MAP: Record<string, string> = {
  Hourglass: 'Dáng đồng hồ cát',
  Pear: 'Dáng quả lê',
  Apple: 'Dáng quả táo',
  Rectangle: 'Dáng chữ nhật',
  'Inverted Triangle': 'Dáng tam giác ngược',
};

@Component({
  selector: 'app-product-detail-page',
  imports: [ProductCard, RouterLink],
  host: { style: 'display:block' },
  templateUrl: './product-detail.page.html',
})
export class ProductDetailPage {
  private readonly catalog = inject(CatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly cart = inject(CartStore);
  private readonly wishlist = inject(WishlistStore);
  private readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly product = signal<ProductSummary | null>(null);
  readonly related = signal<ProductSummary[]>([]);
  readonly quantity = signal(1);
  readonly activeImage = signal(0);
  readonly selectedColor = signal<string | null>(null);
  readonly selectedSize = signal<string | null>(null);
  readonly infoTab = signal<'desc' | 'size' | 'reviews' | 'shipping'>('desc');
  readonly comboPicks = signal<ComboPick[]>([]);
  readonly comboExpanded = signal<number | null>(null);
  readonly starSlots = [1, 2, 3, 4, 5];

  readonly imageUrl = computed(() => {
    const images = this.gallery();
    return toPublicAsset(images[this.activeImage()] || images[0], '/assets/images/placeholder.jpg');
  });
  readonly gallery = computed(() => {
    const item = this.product();
    const images = (item?.images || []).filter(Boolean);
    if (images.length) {
      return images;
    }
    return item?.thumbnail_url ? [item.thumbnail_url] : [];
  });
  readonly colors = computed<ProductColorOption[]>(() => this.colorOptions(this.product()?.variants || []));
  readonly sizes = computed(() => {
    const variants = this.product()?.variants || [];
    const color = this.selectedColor();
    const scoped = color ? variants.filter((row) => row.color === color) : variants;
    return [...new Set(scoped.map((row) => row.size).filter((value): value is string => Boolean(value)))];
  });
  readonly activeVariant = computed<ProductVariant | null>(() => {
    const variants = this.product()?.variants || [];
    const color = this.selectedColor();
    const size = this.selectedSize();
    if (color && size) {
      return variants.find((row) => row.color === color && row.size === size) || null;
    }
    if (color && !this.sizes().length) {
      return variants.find((row) => row.color === color) || null;
    }
    return null;
  });
  readonly isCombo = computed(
    () => Boolean(this.product()?.is_combo && (this.product()?.combo_components?.length || 0) > 0),
  );
  readonly comboComponents = computed(() => this.product()?.combo_components || []);
  readonly discountPercent = computed(() => {
    const item = this.product();
    if (!item?.sale_price || !item.base_price || item.base_price <= item.sale_price) {
      return 0;
    }
    return Math.round(((item.base_price - item.sale_price) / item.base_price) * 100);
  });
  readonly badges = computed<ProductBadge[]>(() => {
    const item = this.product();
    if (!item) {
      return [];
    }
    const rows: ProductBadge[] = [];
    if (this.discountPercent() > 0) {
      rows.push({ kind: 'sale', label: `-${this.discountPercent()}%` });
    }
    if ((item.sold_count || 0) > 0) {
      rows.push({ kind: 'hot', label: 'Bán chạy' });
    } else if (item.is_featured) {
      rows.push({ kind: 'new', label: 'Nổi bật' });
    }
    if (item.is_combo) {
      rows.push({ kind: 'combo', label: 'Combo Set' });
    }
    rows.push({ kind: 'stock', label: this.stockLabel() });
    return rows;
  });
  readonly stockLabel = computed(() => {
    if (this.isCombo()) {
      const stocks = this.comboComponents().map((_, index) => this.comboStock(index));
      const stock = stocks.length ? Math.min(...stocks) : 0;
      if (stock <= 0) {
        return 'Hết hàng';
      }
      return `Còn ${stock} sản phẩm`;
    }
    const variant = this.activeVariant();
    const stock = variant?.stock_quantity;
    if (stock == null) {
      return 'Đang cập nhật...';
    }
    if (stock <= 0) {
      return 'Hết hàng';
    }
    return `Còn ${stock} sản phẩm`;
  });
  readonly priceLabel = computed(() => formatVnd(this.product()?.sale_price || this.product()?.base_price));
  readonly oldPriceLabel = computed(() => {
    const item = this.product();
    if (item?.sale_price && item.base_price && item.base_price > item.sale_price) {
      return formatVnd(item.base_price);
    }
    return '';
  });
  readonly ratingValue = computed(() => Number(this.product()?.rating_value || 0));
  readonly ratingLabel = computed(() => this.ratingValue().toFixed(1));
  readonly roundedRating = computed(() => Math.round(this.ratingValue()));
  readonly wishlisted = computed(() => {
    const id = this.product()?.product_id;
    return id ? this.wishlist.has(id) : false;
  });
  readonly isOutOfStock = computed(() => this.product()?.status === 'out_of_stock');
  readonly reviews = computed(() => this.product()?.reviews || []);
  readonly specRows = computed<SpecRow[]>(() => {
    const item = this.product();
    if (!item) {
      return [];
    }
    const rows: SpecRow[] = [
      { label: 'Mã sản phẩm (SKU)', value: item.sku || '—' },
      { label: 'Xuất xứ', value: 'Velura Atelier' },
    ];
    if (item.brand) {
      rows.push({ label: 'Thương hiệu', value: item.brand });
    }
    if (item.collection) {
      rows.push({ label: 'Bộ sưu tập', value: item.collection });
    }
    if (item.color_tone) {
      rows.push({
        label: 'Tông màu khuyên dùng',
        value: `Tông da ${TONE_MAP[item.color_tone] || item.color_tone}`,
      });
    }
    if (item.style_tags?.length) {
      rows.push({ label: 'Phong cách', value: item.style_tags.join(', ') });
    }
    if (item.occasions?.length) {
      rows.push({
        label: 'Dịp phù hợp',
        value: item.occasions.map((row) => OCCASION_MAP[row] || row).join(', '),
      });
    }
    if (item.suitable_body_shapes?.length) {
      rows.push({
        label: 'Dáng người phù hợp',
        value: item.suitable_body_shapes.map((row) => SHAPE_MAP[row] || row).join(', '),
      });
    }
    return rows;
  });
  readonly comboSummary = computed(() => {
    const item = this.product();
    const retail = this.comboComponents().reduce((sum, component) => sum + (component.base_price || 0), 0);
    const setPrice = item?.sale_price || item?.base_price || 0;
    const savings = Math.max(0, retail - setPrice);
    const savingsPct = retail > 0 ? Math.round((savings / retail) * 100) : 0;
    return {
      retailLabel: formatVnd(retail),
      savingsLabel: `-${formatVnd(savings)} (${savingsPct}%)`,
      setPriceLabel: formatVnd(setPrice),
    };
  });
  readonly fitHelperText = computed(() => {
    if (!this.auth.isLoggedIn()) {
      return 'Đăng nhập để mở khóa gợi ý size theo Style Profile';
    }
    const size = this.selectedSize();
    return size
      ? `Size ${size} được chọn. Gợi ý size theo Style Profile khi quiz đã lưu.`
      : 'Hoàn thành Style Quiz để nhận gợi ý size theo số đo của bạn';
  });

  constructor() {
    useBodyClass('page-product-detail');
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      if (!id) {
        return;
      }
      this.loading.set(true);
      this.loadError.set(null);
      this.catalog.getProduct(id).subscribe({
        next: (row) => {
          this.product.set(row);
          this.activeImage.set(0);
          this.quantity.set(1);
          this.comboExpanded.set(null);
          this.comboPicks.set(this.buildComboPicks(row));
          const first = row.variants?.[0];
          this.selectedColor.set(first?.color || null);
          this.selectedSize.set(first?.size || null);
          this.loading.set(false);
          this.catalog.getProducts().subscribe({
            next: (rows) => {
              const related = rows
                .filter((item) => item.product_id !== row.product_id)
                .filter((item) => !row.category_slug || item.category_slug === row.category_slug)
                .slice(0, 8);
              this.related.set(related.length ? related : rows.filter((item) => item.product_id !== row.product_id).slice(0, 8));
            },
          });
        },
        error: (error: Error) => {
          this.loadError.set(error.message);
          this.loading.set(false);
        },
      });
    });
  }

  /**
   * Increases the selected quantity.
   */
  increment(): void {
    this.quantity.update((value) => Math.min(99, value + 1));
  }

  /**
   * Decreases the selected quantity.
   */
  decrement(): void {
    this.quantity.update((value) => Math.max(1, value - 1));
  }

  /**
   * Adds the current variant to the original localStorage cart.
   */
  addToCart(): boolean {
    const item = this.buildCartItem();
    if (!item) {
      return false;
    }
    this.cart.addItem(item);
    return true;
  }

  /**
   * Adds to cart then opens the original checkout shipping step.
   */
  buyNow(): void {
    const item = this.buildCartItem();
    if (!item) {
      return;
    }
    this.cart.addItem(item);
    sessionStorage.setItem('checkout_items', JSON.stringify([item]));
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl(this.auth.isLoggedIn() ? '/checkout/user' : '/checkout/guest');
  }

  /**
   * Adds every selected combo variant using the original set payload.
   */
  addComboToCart(): void {
    const lines = this.buildComboLines();
    if (!lines) {
      return;
    }
    this.cart.addCombo(lines, 'Đã thêm set sản phẩm vào giỏ hàng!');
  }

  /**
   * Starts checkout with the selected combo set, matching original buy-now.
   */
  buyComboNow(): void {
    const lines = this.buildComboLines();
    if (!lines) {
      return;
    }
    sessionStorage.setItem('checkout_items', JSON.stringify(lines));
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl(this.auth.isLoggedIn() ? '/checkout/user' : '/checkout/guest');
  }

  /**
   * Toggles the original detail-page wishlist button.
   */
  toggleWishlist(): void {
    const id = this.product()?.product_id;
    if (!id) {
      return;
    }
    if (!this.auth.isLoggedIn()) {
      showToast('Vui lòng đăng nhập để lưu sản phẩm!');
      return;
    }
    const wasSaved = this.wishlist.has(id);
    this.wishlist.toggle(id);
    showToast(wasSaved ? 'Đã xóa khỏi danh sách yêu thích' : 'Đã thêm vào danh sách yêu thích!');
  }

  /**
   * Expands or collapses one combo component so the shopper can pick color/size.
   */
  toggleCombo(index: number): void {
    this.comboExpanded.update((current) => (current === index ? null : index));
  }

  /**
   * Selects a color for one item inside the set.
   */
  selectComboColor(index: number, color: string): void {
    const component = this.comboComponents()[index];
    if (!component) {
      return;
    }
    const sizes = this.componentSizes(component, color);
    const size = sizes[0] || '';
    this.patchComboPick(index, color, size);
  }

  /**
   * Selects a size for one item inside the set.
   */
  selectComboSize(index: number, size: string): void {
    const pick = this.comboPicks()[index];
    if (!pick) {
      return;
    }
    this.patchComboPick(index, pick.color, size);
  }

  /**
   * Returns color swatches for one combo component.
   */
  componentColors(component: ComboComponent): ProductColorOption[] {
    return this.colorOptions(component.variants || []);
  }

  /**
   * Returns sizes available for the currently selected color of one combo item.
   */
  componentSizes(component: ComboComponent, color: string): string[] {
    return [
      ...new Set(
        (component.variants || [])
          .filter((row) => !color || row.color === color)
          .map((row) => row.size)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
  }

  /**
   * Remaining stock for the selected variant of one combo item.
   */
  comboStock(index: number): number {
    const component = this.comboComponents()[index];
    const pick = this.comboPicks()[index];
    if (!component || !pick) {
      return 0;
    }
    const variant = this.findVariant(component.variants || [], pick.color, pick.size);
    if (!variant) {
      return 0;
    }
    return Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0));
  }

  /**
   * Public image helper for combo thumbnails.
   */
  comboImage(component: ComboComponent): string {
    return toPublicAsset(component.images?.[0], '/assets/images/placeholder.jpg');
  }

  /**
   * Retail price shown on each combo row (original "mua lẻ" comparison).
   */
  comboRetailLabel(component: ComboComponent): string {
    return formatVnd(component.base_price);
  }

  /**
   * Selects a gallery image by index.
   */
  selectImage(index: number): void {
    this.activeImage.set(index);
  }

  /**
   * Shows the previous gallery image.
   */
  prevImage(): void {
    this.activeImage.update((index) => Math.max(0, index - 1));
  }

  /**
   * Shows the next gallery image.
   */
  nextImage(): void {
    this.activeImage.update((index) => Math.min(this.gallery().length - 1, index + 1));
  }

  /**
   * Rewrites a gallery asset path for Angular public assets.
   */
  gallerySrc(url: string): string {
    return toPublicAsset(url, '/assets/images/placeholder.jpg');
  }

  /**
   * Selects a color swatch from the original option list.
   */
  selectColor(color: string): void {
    this.selectedColor.set(color);
    const sizes = this.sizes();
    if (sizes.length && !sizes.includes(this.selectedSize() || '')) {
      this.selectedSize.set(sizes[0]);
    }
  }

  /**
   * Selects a size option from the original option list.
   */
  selectSize(size: string): void {
    this.selectedSize.set(size);
  }

  /**
   * Switches the original product info tabs.
   */
  setInfoTab(tab: 'desc' | 'size' | 'reviews' | 'shipping'): void {
    this.infoTab.set(tab);
  }

  /**
   * Returns whether a star slot is filled for the current rating.
   */
  isStarFilled(slot: number): boolean {
    return slot <= this.roundedRating();
  }

  private buildComboPicks(row: ProductSummary): ComboPick[] {
    return (row.combo_components || []).map((component) => {
      const first = component.variants?.[0];
      return {
        productId: component.product_id,
        color: first?.color || '',
        size: first?.size || '',
      };
    });
  }

  private patchComboPick(index: number, color: string, size: string): void {
    const next = [...this.comboPicks()];
    const current = next[index];
    if (!current) {
      return;
    }
    next[index] = { ...current, color, size };
    this.comboPicks.set(next);
  }

  private colorOptions(variants: ProductVariant[]): ProductColorOption[] {
    const map = new Map<string, string>();
    for (const row of variants) {
      if (row.color && !map.has(row.color)) {
        map.set(row.color, row.color_hex || '#CCCCCC');
      }
    }
    return [...map.entries()].map(([name, hex]) => ({ name, hex }));
  }

  private findVariant(variants: ProductVariant[], color: string, size: string): ProductVariant | null {
    if (color && size) {
      return variants.find((row) => row.color === color && row.size === size) || null;
    }
    if (color) {
      return variants.find((row) => row.color === color) || null;
    }
    return variants[0] || null;
  }

  private buildComboLines(): CartLine[] | null {
    const item = this.product();
    if (!item) {
      return null;
    }
    const missing = this.comboComponents().filter((component, index) => {
      const pick = this.comboPicks()[index];
      return !this.findVariant(component.variants || [], pick?.color || '', pick?.size || '');
    });
    if (missing.length) {
      showToast(`Vui lòng chọn màu sắc và kích cỡ cho: ${missing.map((row) => row.name).join(', ')}`);
      return null;
    }
    const comboId = `combo-${item.product_id}-${Date.now()}`;
    const comboPrice = item.sale_price || item.base_price || 0;
    return this.comboComponents().map((component, index) => {
      const pick = this.comboPicks()[index];
      const variant = this.findVariant(component.variants || [], pick.color, pick.size);
      return {
        variant_id: variant?.variant_id || component.product_id,
        product_id: component.product_id,
        product_name: component.name,
        product_image: this.comboImage(component),
        quantity: component.quantity || 1,
        unit_price: component.sale_price || component.base_price || 0,
        color: pick.color || variant?.color,
        size: pick.size || variant?.size,
        combo_id: comboId,
        combo_name: item.name,
        combo_price: comboPrice,
      };
    });
  }

  private buildCartItem(): CartLine | null {
    const item = this.product();
    if (!item) {
      return null;
    }
    if (this.isOutOfStock()) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return null;
    }
    if ((this.colors().length && !this.selectedColor()) || (this.sizes().length && !this.selectedSize())) {
      showToast('Vui lòng chọn màu sắc và kích cỡ sản phẩm!');
      return null;
    }
    const variant = this.activeVariant();
    if (!variant && (this.colors().length || this.sizes().length)) {
      showToast('Sản phẩm tùy chọn này hiện không khả dụng!');
      return null;
    }
    return {
      variant_id: variant?.variant_id || item.product_id,
      product_id: item.product_id,
      product_name: item.name,
      product_image: this.imageUrl(),
      quantity: this.quantity(),
      unit_price: item.sale_price || item.base_price || 0,
      color: this.selectedColor() || variant?.color,
      size: this.selectedSize() || variant?.size,
    };
  }
}
