import { AiImageWorkbench } from '../../shared/ai-image-workbench/ai-image-workbench';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ComboComponent,
  ProductColorOption,
  ProductSummary,
  ProductVariant,
} from '../../core/models/product.interface';
import { CartLine, CartComboSubItem } from '../../core/services/cart.store';
import { AuthService } from '../../core/services/auth.service';
import { CartStore } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
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
  imports: [ProductCard, RouterLink, AiImageWorkbench],
  host: { style: 'display:block' },
  templateUrl: './product-detail.page.html',
})
export class ProductDetailPage {
  private readonly catalog = inject(CatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly cart = inject(CartStore);
  private readonly checkout = inject(CheckoutStore);
  private readonly wishlist = inject(WishlistStore);
  private readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly product = signal<ProductSummary | null>(null);
  readonly related = signal<ProductSummary[]>([]);
  readonly aiVariantId = computed(() =>
    this.product()?.variants?.find(v => v.color === this.selectedColor() && v.size === this.selectedSize())?.variant_id ||
    this.product()?.variants?.[0]?.variant_id || ''
  );
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
  readonly comboMaxStock = computed(() => {
    const components = this.comboComponents();
    if (!components.length) {
      return 0;
    }
    const picks = this.comboPicks();
    if (!picks.length) {
      return 0;
    }
    const limits = components.map((comp, index) => {
      const required = Math.max(1, comp.quantity || 1);
      const stock = this.comboStock(index);
      return Math.floor(stock / required);
    });
    return Math.max(0, Math.min(...limits));
  });

  readonly maxAvailableStock = computed(() => {
    if (this.isCombo()) {
      return Math.min(99, this.comboMaxStock());
    }
    const variant = this.activeVariant();
    if (variant) {
      const available = Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0));
      return Math.min(99, available);
    }
    const variants = this.product()?.variants || [];
    if (variants.length > 0) {
      const total = variants.reduce(
        (sum, v) => sum + Math.max(0, (v.stock_quantity || 0) - (v.reserved_quantity || 0)),
        0
      );
      return Math.min(99, total);
    }
    return 99;
  });

  readonly stockLabel = computed(() => {
    if (this.isCombo()) {
      const stock = this.comboMaxStock();
      if (stock <= 0) {
        return 'Hết hàng';
      }
      return `Còn ${stock} sản phẩm`;
    }
    const variant = this.activeVariant();
    const stock = variant ? Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0)) : undefined;
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
  readonly isOutOfStock = computed(() => {
    if (this.product()?.status === 'out_of_stock') return true;
    if (this.isCombo()) {
      const components = this.comboComponents();
      if (!components.length) return true;
      const picks = this.comboPicks();
      if (!picks.length) return false;
      return this.comboMaxStock() <= 0;
    }
    const variant = this.activeVariant();
    if (variant) {
      return (variant.stock_quantity || 0) - (variant.reserved_quantity || 0) <= 0;
    }
    const variants = this.product()?.variants || [];
    if (variants.length > 0) {
      const totalAvailable = variants.reduce(
        (sum, v) => sum + Math.max(0, (v.stock_quantity || 0) - (v.reserved_quantity || 0)),
        0
      );
      return totalAvailable <= 0;
    }
    return false;
  });
  readonly reviews = computed(() => this.product()?.reviews || []);
  readonly averageRating = computed(() => {
    const list = this.reviews();
    if (!list.length) return 0;
    const sum = list.reduce((acc, r) => acc + (r.rating || 0), 0);
    return Number((sum / list.length).toFixed(1));
  });
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
    const setQty = Math.max(1, this.quantity() || 1);
    const retailSingle = this.comboComponents().reduce((sum, component) => {
      const compQty = component.quantity && component.quantity < 10 ? component.quantity : 1;
      return sum + ((component.base_price || 0) * compQty);
    }, 0);
    const retail = retailSingle * setQty;
    const setPrice = (item?.sale_price || item?.base_price || 0) * setQty;
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
          try {
            const raw = localStorage.getItem('velura_recently_viewed');
            const list = raw ? (JSON.parse(raw) as ProductSummary[]) : [];
            const filtered = list.filter((p) => p.product_id !== row.product_id);
            filtered.unshift(row);
            localStorage.setItem('velura_recently_viewed', JSON.stringify(filtered.slice(0, 8)));
          } catch {}
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
    if (this.isOutOfStock()) {
      return;
    }
    const max = this.maxAvailableStock();
    this.quantity.update((value) => Math.min(max > 0 ? max : 99, value + 1));
  }

  /**
   * Decreases the selected quantity.
   */
  decrement(): void {
    if (this.isOutOfStock()) {
      return;
    }
    this.quantity.update((value) => Math.max(1, value - 1));
  }

  /**
   * Adds the current variant to the original localStorage cart.
   */
  addToCart(): boolean {
    if (this.isOutOfStock()) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return false;
    }
    const item = this.buildCartItem();
    if (!item) {
      return false;
    }
    this.cart.addItem(item);
    return true;
  }

  /**
   * Starts instant checkout for the selected variant without polluting the persistent cart.
   */
  buyNow(): void {
    if (this.isOutOfStock()) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return;
    }
    const item = this.buildCartItem();
    if (!item) {
      return;
    }
    this.checkout.setCheckoutItems([item], 'buy_now');
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl('/checkout/shipping');
  }

  /**
   * Adds every selected combo variant using the original set payload.
   */
  addComboToCart(): void {
    if (this.isOutOfStock()) {
      showToast('Set combo hiện đã hết hàng do có sản phẩm thành phần không khả dụng.');
      return;
    }
    const lines = this.buildComboLines();
    if (!lines) {
      return;
    }
    this.cart.addCombo(lines, 'Đã thêm set sản phẩm vào giỏ hàng!');
  }

  /**
   * Starts checkout with the selected combo set directly, matching instant checkout.
   */
  buyComboNow(): void {
    if (this.isOutOfStock()) {
      showToast('Set combo hiện đã hết hàng do có sản phẩm thành phần không khả dụng.');
      return;
    }
    const lines = this.buildComboLines();
    if (!lines) {
      return;
    }
    this.checkout.setCheckoutItems(lines, 'buy_now');
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    void this.router.navigateByUrl('/checkout/shipping');
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
    this.clampQuantity();
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
    this.clampQuantity();
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
   * Selects a gallery image by index and syncs matching color.
   */
  selectImage(index: number): void {
    this.activeImage.set(index);
    const colors = this.colors();
    if (colors[index]) {
      this.selectedColor.set(colors[index].name);
      const sizes = this.sizes();
      if (sizes.length && !sizes.includes(this.selectedSize() || '')) {
        this.selectedSize.set(sizes[0]);
      }
      this.clampQuantity();
    }
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
   * Selects a color swatch and switches the gallery image to match.
   */
  selectColor(color: string): void {
    this.selectedColor.set(color);
    const gallery = this.gallery();
    const colors = this.colors();
    const colorIndex = colors.findIndex((c) => c.name === color);
    if (colorIndex >= 0 && colorIndex < gallery.length) {
      this.activeImage.set(colorIndex);
    } else {
      const slug = color.toLowerCase().replace(/\s+/g, '-');
      const foundIdx = gallery.findIndex((url) => url.toLowerCase().includes(slug));
      if (foundIdx >= 0) {
        this.activeImage.set(foundIdx);
      }
    }
    const sizes = this.sizes();
    if (sizes.length && !sizes.includes(this.selectedSize() || '')) {
      this.selectedSize.set(sizes[0]);
    }
    this.clampQuantity();
  }
  /**
   * Selects a size option from the original option list.
   */
  selectSize(size: string): void {
    this.selectedSize.set(size);
    this.clampQuantity();
  }

  /**
   * Checks if a size variant is out of stock for the selected color.
   */
  isSizeOutOfStock(size: string): boolean {
    const variants = this.product()?.variants || [];
    const color = this.selectedColor();
    const variant = variants.find((v) => (!color || v.color === color) && v.size === size);
    if (!variant) return false;
    return (variant.stock_quantity || 0) - (variant.reserved_quantity || 0) <= 0;
  }

  /**
   * Checks if a combo component size variant is out of stock for the given color.
   */
  isComboSizeOutOfStock(component: ComboComponent, color: string, size: string): boolean {
    const variant = this.findVariant(component.variants || [], color, size);
    if (!variant) return false;
    return (variant.stock_quantity || 0) - (variant.reserved_quantity || 0) <= 0;
  }

  private clampQuantity(): void {
    const max = this.maxAvailableStock();
    if (max > 0 && this.quantity() > max) {
      this.quantity.set(max);
    }
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
    const setQty = Math.max(1, this.quantity() || 1);
    const required = new Map<string, { quantity: number; available: number }>();
    for (const [index, component] of this.comboComponents().entries()) {
      const pick = this.comboPicks()[index];
      const variant = this.findVariant(component.variants || [], pick.color, pick.size);
      if (!variant) return null;
      const previous = required.get(variant.variant_id);
      required.set(variant.variant_id, {
        quantity: (previous?.quantity || 0) + Math.max(1, component.quantity || 1) * setQty,
        available: Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0)),
      });
    }
    if ([...required.values()].some((row) => row.quantity > row.available)) {
      showToast('Số lượng set đã chọn vượt quá tồn kho khả dụng. Vui lòng giảm số lượng.');
      return null;
    }
    const subItems: CartComboSubItem[] = this.comboComponents().map((component, index) => {
      const pick = this.comboPicks()[index];
      const variant = this.findVariant(component.variants || [], pick?.color || '', pick?.size || '');
      return {
        product_id: component.product_id,
        product_name: component.name,
        product_image: this.comboImage(component),
        variant_id: variant?.variant_id || component.product_id,
        color: pick?.color || variant?.color || '',
        size: pick?.size || variant?.size || '',
        quantity: Math.max(1, component.quantity || 1),
        available_variants: (component.variants || []).map((v) => ({
          variant_id: v.variant_id,
          color: v.color,
          size: v.size,
          stock_quantity: v.stock_quantity,
          reserved_quantity: v.reserved_quantity,
        })),
      };
    });

    const comboVariant = item.variants?.[0];
    const comboVariantId = comboVariant?.variant_id || subItems[0]?.variant_id || item.product_id;

    const comboLine: CartLine = {
      variant_id: comboVariantId,
      product_id: item.product_id,
      product_name: item.name,
      product_image: this.imageUrl(),
      quantity: setQty,
      unit_price: comboPrice,
      is_combo: true,
      sub_items: subItems,
      combo_id: comboId,
      combo_name: item.name,
      combo_price: comboPrice,
      combo_image: this.imageUrl(),
    };
    return [comboLine];
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
    if (variant && this.quantity() > Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0))) {
      showToast('Số lượng đã chọn vượt quá tồn kho khả dụng. Vui lòng giảm số lượng.');
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
