import { AiImageWorkbench } from '../../shared/ai-image-workbench/ai-image-workbench';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ComboComponent,
  ProductColorOption,
  ProductReview,
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
import { formatSizeDisplay, sortSizes } from '../../core/utils/size';
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
  readonly aiVariantId = computed(() => {
    const color = this.selectedColor();
    const size = this.selectedSize();
    const variants = this.product()?.variants || [];
    if (color && size) {
      return variants.find((v) => v.color === color && v.size === size)?.variant_id || '';
    }
    if (color && !this.sizes().length) {
      return variants.find((v) => v.color === color)?.variant_id || '';
    }
    return '';
  });
  readonly quantity = signal(1);
  readonly activeImage = signal(0);
  readonly selectedColor = signal<string | null>(null);
  readonly selectedSize = signal<string | null>(null);
  readonly infoTab = signal<'desc' | 'size' | 'reviews' | 'shipping'>('desc');
  readonly comboPicks = signal<ComboPick[]>([]);
  readonly comboExpanded = signal<number | null>(null);
  readonly starSlots = [1, 2, 3, 4, 5];
  readonly Math = Math;
  readonly displaySize = formatSizeDisplay;

  readonly isZoomOpen = signal(false);
  readonly zoomScale = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly isDragging = signal(false);
  private dragStartX = 0;
  private dragStartY = 0;
  private initialPanX = 0;
  private initialPanY = 0;

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
  readonly colors = computed<ProductColorOption[]>(() =>
    this.colorOptions(this.product()?.variants || []),
  );
  readonly sizes = computed(() => {
    const variants = this.product()?.variants || [];
    const color = this.selectedColor();
    const scoped = color ? variants.filter((row) => row.color === color) : variants;
    return sortSizes([
      ...new Set(scoped.map((row) => row.size).filter((value): value is string => Boolean(value))),
    ]);
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
    if (this.isDiscontinued()) {
      return 'Ngừng kinh doanh';
    }
    if (this.isHidden()) {
      return 'Tạm ẩn';
    }
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
  readonly ratingValue = computed(() => Number(this.product()?.rating_value || this.averageRating() || 0));
  readonly ratingCount = computed(() => Number(this.product()?.rating_count || this.reviews().length || 0));
  readonly ratingLabel = computed(() => this.ratingValue().toFixed(1));
  readonly roundedRating = computed(() => Math.round(this.ratingValue()));
  readonly likedReviews = signal<Record<string, boolean>>(this.readLikedReviews());
  readonly likeCounts = signal<Record<string, number>>({});
  readonly wishlisted = computed(() => {
    const id = this.product()?.product_id;
    return id ? this.wishlist.has(id) : false;
  });
  readonly isDiscontinued = computed(() => this.product()?.status === 'discontinued');
  readonly isHidden = computed(() => this.product()?.status === 'hidden');
  readonly isBuyDisabled = computed(() => this.isOutOfStock() || this.isDiscontinued() || this.isHidden());
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
  readonly reviewStarFilter = signal<number | null>(null);
  readonly reviewMediaFilter = signal<'all' | 'with_photos' | 'with_reply'>('all');
  readonly reviewTagFilter = signal<string | null>(null);
  readonly reviewSort = signal<'newest' | 'helpful' | 'rating_desc' | 'rating_asc'>('newest');
  readonly reviewCarouselIndex = signal<number>(0);
  readonly canScrollReviewsPrev = signal<boolean>(false);
  readonly canScrollReviewsNext = signal<boolean>(true);
  readonly previewReviewImage = signal<string | null>(null);

  readonly starBreakdown = computed(() => {
    const list = this.reviews();
    const total = list.length;
    return [5, 4, 3, 2, 1].map((star) => {
      const count = list.filter((r) => Math.round(Number(r.rating || 0)) === star).length;
      const percent = total > 0 ? Math.round((count / total) * 100) : 0;
      return { star, count, percent };
    });
  });

  readonly reviewsWithPhotosCount = computed(
    () => this.reviews().filter((r) => Array.isArray(r.images) && r.images.length > 0).length,
  );

  readonly reviewsWithReplyCount = computed(
    () => this.reviews().filter((r) => Boolean(r.admin_reply && String(r.admin_reply).trim())).length,
  );

  readonly availableReviewTags = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.reviews()) {
      for (const tag of r.review_tags || []) {
        const trimmed = String(tag || '').trim();
        if (trimmed) {
          counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 7);
  });

  readonly hasActiveReviewFilter = computed(
    () =>
      this.reviewStarFilter() !== null ||
      this.reviewMediaFilter() !== 'all' ||
      this.reviewTagFilter() !== null,
  );

  readonly filteredReviews = computed(() => {
    const star = this.reviewStarFilter();
    const media = this.reviewMediaFilter();
    const tag = this.reviewTagFilter();
    const sort = this.reviewSort();

    const filtered = this.reviews().filter((r) => {
      if (star !== null && Math.round(Number(r.rating || 0)) !== star) {
        return false;
      }
      if (media === 'with_photos' && (!Array.isArray(r.images) || r.images.length === 0)) {
        return false;
      }
      if (media === 'with_reply' && !Boolean(r.admin_reply && String(r.admin_reply).trim())) {
        return false;
      }
      if (tag !== null && !(r.review_tags || []).includes(tag)) {
        return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'helpful') {
        return this.reviewLikeCount(b) - this.reviewLikeCount(a);
      }
      if (sort === 'rating_desc') {
        return Number(b.rating || 0) - Number(a.rating || 0);
      }
      if (sort === 'rating_asc') {
        return Number(a.rating || 0) - Number(b.rating || 0);
      }
      const timeA = new Date(a.submitted_at || a.created_at || 0).getTime();
      const timeB = new Date(b.submitted_at || b.created_at || 0).getTime();
      return timeB - timeA;
    });
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
          if (typeof document !== 'undefined') {
            document.title = row.seo_title || `${row.name} | Velura Atelier`;
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc && (row.seo_description || row.description)) {
              metaDesc.setAttribute('content', String(row.seo_description || row.description).slice(0, 160));
            }
          }
          try {
            const raw = localStorage.getItem('velura_recently_viewed');
            const list = raw ? (JSON.parse(raw) as ProductSummary[]) : [];
            const filtered = list.filter((p) => p.product_id !== row.product_id);
            filtered.unshift(row);
            localStorage.setItem('velura_recently_viewed', JSON.stringify(filtered.slice(0, 8)));
          } catch {}
          this.quantity.set(1);
          this.comboExpanded.set(null);
          this.comboPicks.set(this.buildComboPicks(row));
          const primaryColor = row.image_colors?.[this.gallery()[0]];
          const initialColor = (primaryColor
            ? this.colors().find((option) => option.name.trim().toLowerCase() === primaryColor.trim().toLowerCase())?.name
            : null)
            || this.colors()[0]?.name || row.variants?.[0]?.color || null;
          this.selectedColor.set(initialColor);
          this.selectedSize.set(this.sizes()[0] || null);
          this.activeImage.set(0);
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
    if (this.isDiscontinued()) {
      showToast('Sản phẩm đã ngừng kinh doanh.');
      return false;
    }
    if (this.isHidden()) {
      showToast('Sản phẩm hiện đang tạm ẩn.');
      return false;
    }
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
    if (this.isDiscontinued()) {
      showToast('Sản phẩm đã ngừng kinh doanh.');
      return;
    }
    if (this.isHidden()) {
      showToast('Sản phẩm hiện đang tạm ẩn.');
      return;
    }
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
    if (this.isDiscontinued()) {
      showToast('Set combo đã ngừng kinh doanh.');
      return;
    }
    if (this.isHidden()) {
      showToast('Set combo hiện đang tạm ẩn.');
      return;
    }
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
    if (this.isDiscontinued()) {
      showToast('Set combo đã ngừng kinh doanh.');
      return;
    }
    if (this.isHidden()) {
      showToast('Set combo hiện đang tạm ẩn.');
      return;
    }
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
    return sortSizes([
      ...new Set(
        (component.variants || [])
          .filter((row) => !color || row.color === color)
          .map((row) => row.size)
          .filter((value): value is string => Boolean(value)),
      ),
    ]);
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
   * Selects a gallery image; only an explicit color association changes the selected variant.
   */
  selectImage(index: number): void {
    this.activeImage.set(index);
    const url = this.gallery()[index];
    const color = url ? this.product()?.image_colors?.[url] : undefined;
    if (color && (!this.selectedColor() || color.trim().toLowerCase() !== this.selectedColor()!.trim().toLowerCase())) {
      const matched = this.colors().find((option) => option.name.trim().toLowerCase() === color.trim().toLowerCase());
      if (matched) {
        this.selectedColor.set(matched.name);
        const sizes = this.sizes();
        if (!sizes.includes(this.selectedSize() || '')) {
          this.selectedSize.set(sizes[0] || null);
        }
        this.clampQuantity();
      }
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
   * Selects a color and shows its first associated image, then a common image, then the primary.
   */
  selectColor(color: string): void {
    this.selectedColor.set(color);
    this.activeImage.set(this.imageIndexForColor(color));
    const sizes = this.sizes();
    if (!sizes.includes(this.selectedSize() || '')) {
      this.selectedSize.set(sizes[0] || null);
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

  /**
   * Checks whether the current browser has hearted a review.
   */
  isReviewLiked(review: ProductReview): boolean {
    const id = review.review_id || '';
    return Boolean(id && this.likedReviews()[id]);
  }

  /**
   * Resolves the helpful heart count for a review.
   */
  reviewLikeCount(review: ProductReview): number {
    const id = review.review_id || '';
    if (id && this.likeCounts()[id] !== undefined) {
      return this.likeCounts()[id];
    }
    return Math.max(0, Number(review.helpful_count || 0));
  }

  /**
   * Toggles heart (helpful) status on a product review and persists it to the API.
   */
  toggleReviewLike(review: ProductReview): void {
    const id = review.review_id;
    if (!id) {
      return;
    }
    const currentlyLiked = this.isReviewLiked(review);
    const nextLiked = !currentlyLiked;
    const currentCount = this.reviewLikeCount(review);
    const nextCount = nextLiked ? currentCount + 1 : Math.max(0, currentCount - 1);

    const nextMap = { ...this.likedReviews(), [id]: nextLiked };
    this.likedReviews.set(nextMap);
    this.likeCounts.update((counts) => ({ ...counts, [id]: nextCount }));
    try {
      localStorage.setItem('velura_liked_reviews', JSON.stringify(nextMap));
    } catch {}

    this.catalog.likeReview(id, nextLiked).subscribe({
      next: (res) => {
        if (typeof res?.helpful_count === 'number') {
          this.likeCounts.update((counts) => ({ ...counts, [id]: res.helpful_count }));
        }
      },
      error: () => {
        // Keep optimistic local state if offline
      },
    });
  }

  /**
   * Formats a review timestamp for display.
   */
  formatReviewDate(value?: string): string {
    if (!value) {
      return '';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    return parsed.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  /**
   * Extracts 1-2 uppercase initials from customer name for review avatar.
   */
  reviewerInitials(name?: string): string {
    const clean = (name || 'Khách hàng Velura').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
    }
    return (clean.slice(0, 2) || 'KH').toUpperCase();
  }

  /**
   * Filters reviews by star rating (toggles off when clicking the active star).
   */
  setReviewStarFilter(star: number | null, trackEl?: HTMLElement | null): void {
    this.reviewStarFilter.update((current) => (current === star ? null : star));
    this.resetReviewScroll(trackEl);
  }

  /**
   * Filters reviews by media or CSKH reply presence.
   */
  setReviewMediaFilter(mode: 'all' | 'with_photos' | 'with_reply', trackEl?: HTMLElement | null): void {
    this.reviewMediaFilter.update((current) => (current === mode && mode !== 'all' ? 'all' : mode));
    this.resetReviewScroll(trackEl);
  }

  /**
   * Toggles a preset review tag filter chip.
   */
  toggleReviewTagFilter(tag: string, trackEl?: HTMLElement | null): void {
    this.reviewTagFilter.update((current) => (current === tag ? null : tag));
    this.resetReviewScroll(trackEl);
  }

  /**
   * Updates the sort order of product reviews.
   */
  setReviewSort(sort: 'newest' | 'helpful' | 'rating_desc' | 'rating_asc', trackEl?: HTMLElement | null): void {
    this.reviewSort.set(sort);
    this.resetReviewScroll(trackEl);
  }

  /**
   * Clears all active review filters and resets scroll position.
   */
  resetReviewFilters(trackEl?: HTMLElement | null): void {
    this.reviewStarFilter.set(null);
    this.reviewMediaFilter.set('all');
    this.reviewTagFilter.set(null);
    this.reviewSort.set('newest');
    this.resetReviewScroll(trackEl);
  }

  /**
   * Smoothly scrolls the horizontal review carousel left (-1) or right (1).
   */
  scrollReviewsCarousel(direction: -1 | 1, trackEl?: HTMLElement | null): void {
    if (!trackEl) return;
    const cardWidth = 384;
    const nextLeft = Math.max(0, trackEl.scrollLeft + direction * cardWidth);
    trackEl.scrollTo({ left: nextLeft, behavior: 'smooth' });
    setTimeout(() => this.syncReviewScrollState(trackEl), 320);
  }

  /**
   * Jumps smoothly to a specific review card index in the horizontal carousel.
   */
  scrollToReviewSlide(index: number, trackEl?: HTMLElement | null): void {
    if (!trackEl) return;
    const cardWidth = 384;
    trackEl.scrollTo({ left: Math.max(0, index * cardWidth), behavior: 'smooth' });
    this.reviewCarouselIndex.set(index);
    setTimeout(() => this.syncReviewScrollState(trackEl), 320);
  }

  /**
   * Tracks native scroll position of the horizontal review carousel.
   */
  onReviewsTrackScroll(event: Event): void {
    const el = event.target as HTMLElement | null;
    if (el) {
      this.syncReviewScrollState(el);
    }
  }

  /**
   * Opens a review photo in the lightbox preview modal.
   */
  openReviewImageLightbox(url: string): void {
    if (url) {
      this.previewReviewImage.set(url);
    }
  }

  /**
   * Closes the review photo lightbox modal.
   */
  closeReviewImageLightbox(): void {
    this.previewReviewImage.set(null);
  }

  private resetReviewScroll(trackEl?: HTMLElement | null): void {
    this.reviewCarouselIndex.set(0);
    this.canScrollReviewsPrev.set(false);
    this.canScrollReviewsNext.set(true);
    if (trackEl) {
      trackEl.scrollTo({ left: 0, behavior: 'smooth' });
      setTimeout(() => this.syncReviewScrollState(trackEl), 200);
    }
  }

  private syncReviewScrollState(trackEl: HTMLElement): void {
    const cardWidth = 384;
    const maxScroll = Math.max(0, trackEl.scrollWidth - trackEl.clientWidth);
    const current = Math.max(0, trackEl.scrollLeft);
    const idx = Math.min(
      Math.max(0, this.filteredReviews().length - 1),
      Math.round(current / cardWidth),
    );
    this.reviewCarouselIndex.set(idx);
    this.canScrollReviewsPrev.set(current > 12);
    this.canScrollReviewsNext.set(current < maxScroll - 12);
  }
  private readLikedReviews(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem('velura_liked_reviews');
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, boolean>;
        }
      }
    } catch {}
    return {};
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

  openImageZoom(): void {
    this.isZoomOpen.set(true);
    this.resetZoom();
  }

  closeImageZoom(): void {
    this.isZoomOpen.set(false);
    this.resetZoom();
  }

  zoomIn(): void {
    this.zoomScale.update((scale) => Math.min(3, Math.round((scale + 0.5) * 10) / 10));
  }

  zoomOut(): void {
    this.zoomScale.update((scale) => {
      const next = Math.max(1, Math.round((scale - 0.5) * 10) / 10);
      if (next === 1) {
        this.panX.set(0);
        this.panY.set(0);
      }
      return next;
    });
  }

  resetZoom(): void {
    this.zoomScale.set(1);
    this.panX.set(0);
    this.panY.set(0);
    this.isDragging.set(false);
  }

  toggleZoom(): void {
    if (this.zoomScale() > 1) {
      this.resetZoom();
    } else {
      this.zoomScale.set(2);
    }
  }

  onZoomWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoomIn();
    } else if (event.deltaY > 0) {
      this.zoomOut();
    }
  }

  onPanStart(event: MouseEvent): void {
    if (this.zoomScale() <= 1) return;
    this.isDragging.set(true);
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.initialPanX = this.panX();
    this.initialPanY = this.panY();
  }

  onPanMove(event: MouseEvent): void {
    if (!this.isDragging() || this.zoomScale() <= 1) return;
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    const maxPan = 150 * (this.zoomScale() - 1);
    this.panX.set(Math.max(-maxPan, Math.min(maxPan, this.initialPanX + dx)));
    this.panY.set(Math.max(-maxPan, Math.min(maxPan, this.initialPanY + dy)));
  }

  onPanEnd(): void {
    this.isDragging.set(false);
  }

  prevZoomImage(): void {
    this.prevImage();
    this.resetZoom();
  }

  nextZoomImage(): void {
    this.nextImage();
    this.resetZoom();
  }

  private imageIndexForColor(color: string): number {
    const gallery = this.gallery();
    const imageColors = this.product()?.image_colors;
    const norm = color.trim().toLowerCase();
    const matchingIndex = gallery.findIndex((url) => {
      const mapped = imageColors?.[url];
      return mapped ? mapped.trim().toLowerCase() === norm : false;
    });
    if (matchingIndex >= 0) {
      return matchingIndex;
    }
    const commonIndex = gallery.findIndex((url) => imageColors?.[url] === undefined);
    return commonIndex >= 0 ? commonIndex : 0;
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
