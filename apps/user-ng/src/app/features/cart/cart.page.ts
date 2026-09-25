import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CartLine, CartStore, GroupedCartItem } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { ApiService } from '../../core/services/api.service';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';
import { VoucherWallet } from '../../shared/voucher-wallet/voucher-wallet';
import type { AppliedVoucher, CartItemRef } from '../../core/models/voucher.interface';

const ITEMS_PER_PAGE = 5;
const SELECTED_KEY = 'selected_cart_items';
const CHECKOUT_ITEMS_KEY = 'checkout_items';
const VOUCHER_ID_KEY = 'checkout_voucher_id';
/** Khách đã chủ động bỏ mã ở giỏ; trang thanh toán không tự áp lại. */
const VOUCHER_DECLINED_KEY = 'checkout_voucher_declined';

type PageItem = { kind: 'page'; value: number } | { kind: 'dots'; value: number };

@Component({
  selector: 'app-cart-page',
  imports: [RouterLink, VoucherWallet],
  host: {
    class: 'page-cart',
    style: 'display:block',
    '(document:click)': 'closeAllDropdowns()',
  },
  templateUrl: './cart.page.html',
})
export class CartPage {
  private readonly cart = inject(CartStore);
  private readonly checkoutStore = inject(CheckoutStore);
  private readonly api = inject(ApiService);
  readonly editingVariantId = signal<string | null>(null);
  readonly variantChoices = signal<Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }>>([]);
  readonly activeDropdown = signal<{ variantId: string; type: 'color' | 'size' } | null>(null);
  private readonly variantsCache = new Map<string, Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }>>();
  readonly variantsVersion = signal(0);
  readonly loadingVariants = signal(false);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Mã mang theo từ nút "Dùng mã" ở trang Ưu đãi (`/cart?voucher=CODE`). */
  readonly preferredVoucher = this.route.snapshot.queryParamMap.get('voucher');
  readonly appliedVoucher = signal<AppliedVoucher | null>(null);
  readonly voucherDeclined = signal(false);

  readonly referralCode = signal(this.checkoutStore.shipping().referral_code || '');
  readonly referralApplied = signal(Boolean(this.checkoutStore.shipping().referral_code));

  readonly currentPage = signal(1);
  readonly selectedIds = signal<string[]>(this.readSelectedIds());
  private hadStoredSelection = sessionStorage.getItem(SELECTED_KEY) !== null;
  readonly groupedItems = computed(() => this.cart.groupItems());
  readonly groupedCount = computed(() =>
    this.groupedItems().reduce((sum, item) => sum + item.quantity, 0),
  );
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.groupedItems().length / ITEMS_PER_PAGE)));
  readonly pagedItems = computed(() => {
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * ITEMS_PER_PAGE;
    return this.groupedItems().slice(start, start + ITEMS_PER_PAGE);
  });
  readonly pageItems = computed<PageItem[]>(() => {
    const total = this.totalPages();
    const current = Math.min(this.currentPage(), total);
    const items: PageItem[] = [];
    for (let page = 1; page <= total; page += 1) {
      if (page === 1 || page === total || Math.abs(page - current) <= 1) {
        items.push({ kind: 'page', value: page });
      } else if (page === current - 2 || page === current + 2) {
        items.push({ kind: 'dots', value: page });
      }
    }
    return items;
  });
  readonly showPagination = computed(() => this.groupedItems().length > ITEMS_PER_PAGE);
  readonly selectedItems = computed(() => {
    const selected = new Set(this.selectedIds());
    return this.groupedItems().filter((item) => selected.has(item.variant_id));
  });
  readonly selectedSubtotal = computed(() =>
    this.selectedItems().reduce((sum, item) => sum + item.unit_price * item.quantity, 0),
  );
  /**
   * Dòng hàng gửi cho ví mã, đã tách combo thành từng biến thể như lúc đặt đơn, để mã
   * theo danh mục được chấm trên đúng những gì sẽ vào đơn.
   */
  readonly selectedRefs = computed<CartItemRef[]>(() =>
    this.cart.expandGroupedItems(this.selectedItems()).map((line) => ({ variant_id: line.variant_id, quantity: line.quantity })),
  );
  /**
   * Tiền giảm ước tính ở giỏ. Phí vận chuyển chưa biết nên mã miễn phí vận chuyển chưa
   * trừ ở đây; con số chốt là báo giá ở trang thanh toán.
   */
  readonly estimatedDiscount = computed(() => {
    const voucher = this.appliedVoucher();
    if (!voucher || voucher.discount_type === 'free_shipping') return 0;
    return Math.min(voucher.discount_amount, this.selectedSubtotal());
  });
  readonly estimatedTotal = computed(() => Math.max(0, this.selectedSubtotal() - this.estimatedDiscount()));
  readonly allSelected = computed(() => {
    const items = this.groupedItems();
    if (!items.length) {
      return false;
    }
    const selected = new Set(this.selectedIds());
    return items.every((item) => selected.has(item.variant_id));
  });

  constructor() {
    useBodyClass('page-cart');
    this.syncSelection(this.groupedItems());
  }

  /**
   * Formats a grouped cart line total.
   */
  lineTotal(item: GroupedCartItem): string {
    return formatVnd(item.unit_price * item.quantity) || '0 đ';
  }

  /** Nhận mã ví đang áp ở giỏ. */
  onVoucherApplied(voucher: AppliedVoucher | null): void {
    this.appliedVoucher.set(voucher);
  }

  onVoucherDeclined(declined: boolean): void {
    this.voucherDeclined.set(declined);
  }

  discountLabel(): string {
    return `-${formatVnd(this.estimatedDiscount()) || '0 đ'}`;
  }

  estimatedTotalLabel(): string {
    return formatVnd(this.estimatedTotal()) || '0 đ';
  }

  /**
   * Formats the selected-items subtotal used by the original summary card.
   */
  subtotalLabel(): string {
    return formatVnd(this.selectedSubtotal()) || '0 đ';
  }

  /**
   * Resolves a cart thumbnail for Angular public assets.
   */
  imageUrl(item: GroupedCartItem | CartLine): string {
    return toPublicAsset(item.product_image, '/assets/images/placeholder.jpg');
  }

  /**
   * Lists combo component names for the original "Gồm:" tag.
   */
  comboIncludes(item: GroupedCartItem): string {
    return (item.items || []).map((part) => part.product_name).join(' + ');
  }

  /**
   * Removes a variant line or combo set using the original cart payload key.
   */
  remove(item: GroupedCartItem): void {
    this.cart.removeItem(item.variant_id);
    this.selectedIds.update((ids) => ids.filter((id) => id !== item.variant_id));
    this.persistSelected();
    this.clampPage();
  }

  /**
   * Loads the other sizes and colors of this product so the buyer can swap the line.
   */
  toggleVariants(item: GroupedCartItem): void {
    if (item.is_combo) {
      return;
    }
    if (this.isDropdownOpen(item, 'color') || this.isDropdownOpen(item, 'size')) {
      this.activeDropdown.set(null);
      this.editingVariantId.set(null);
      this.variantChoices.set([]);
      return;
    }
    this.editingVariantId.set(item.variant_id);
    this.toggleDropdown(item, 'color');
  }

  isDropdownOpen(item: GroupedCartItem, type: 'color' | 'size'): boolean {
    const cur = this.activeDropdown();
    return cur !== null && cur.variantId === item.variant_id && cur.type === type;
  }

  toggleDropdown(item: GroupedCartItem, type: 'color' | 'size', event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    if (item.is_combo) return;
    const cur = this.activeDropdown();
    if (cur && cur.variantId === item.variant_id && cur.type === type) {
      this.activeDropdown.set(null);
      return;
    }
    this.activeDropdown.set({ variantId: item.variant_id, type });
    if (!this.variantsCache.has(item.product_id)) {
      this.loadingVariants.set(true);
      this.api
        .get<{ variants?: Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }> }>(
          `/api/user/products/${item.product_id}`,
        )
        .subscribe({
          next: (product) => {
            const list = product.variants || [];
            this.variantsCache.set(item.product_id, list);
            this.variantChoices.set(list);
            this.variantsVersion.update((v) => v + 1);
            this.loadingVariants.set(false);
          },
          error: () => {
            this.variantsCache.set(item.product_id, []);
            this.variantChoices.set([]);
            this.variantsVersion.update((v) => v + 1);
            this.loadingVariants.set(false);
          },
        });
    } else {
      this.variantChoices.set(this.variantsCache.get(item.product_id) || []);
    }
  }

  getColorsForItem(item: GroupedCartItem): string[] {
    this.variantsVersion();
    const list = this.variantsCache.get(item.product_id) || [];
    const set = new Set<string>();
    if (item.color) set.add(item.color);
    for (const v of list) {
      if (v.color) set.add(v.color);
    }
    return Array.from(set);
  }

  getSizesForItem(item: GroupedCartItem): string[] {
    this.variantsVersion();
    const list = this.variantsCache.get(item.product_id) || [];
    const set = new Set<string>();
    if (item.size) set.add(item.size);
    for (const v of list) {
      if (v.size) set.add(v.size);
    }
    return Array.from(set);
  }

  pickColor(item: GroupedCartItem, color: string): void {
    this.activeDropdown.set(null);
    if (item.color === color) return;
    const list = this.variantsCache.get(item.product_id) || [];
    const match = list.find((v) => v.color === color && v.size === item.size) || list.find((v) => v.color === color);
    if (match) {
      this.cart.replaceVariant(item.variant_id, {
        variant_id: match.variant_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image: item.product_image,
        quantity: item.quantity,
        unit_price: item.unit_price,
        color: match.color || color,
        size: match.size || item.size,
      });
      this.selectedIds.update((ids) => ids.map((id) => (id === item.variant_id ? match.variant_id : id)));
      this.persistSelected();
    }
  }

  pickSize(item: GroupedCartItem, size: string): void {
    this.activeDropdown.set(null);
    if (item.size === size) return;
    const list = this.variantsCache.get(item.product_id) || [];
    const match = list.find((v) => v.size === size && v.color === item.color) || list.find((v) => v.size === size);
    if (match) {
      this.cart.replaceVariant(item.variant_id, {
        variant_id: match.variant_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_image: item.product_image,
        quantity: item.quantity,
        unit_price: item.unit_price,
        color: match.color || item.color,
        size: match.size || size,
      });
      this.selectedIds.update((ids) => ids.map((id) => (id === item.variant_id ? match.variant_id : id)));
      this.persistSelected();
    }
  }

  closeAllDropdowns(): void {
    this.activeDropdown.set(null);
  }

  /**
   * Replaces the cart line with the chosen variant and keeps the quantity.
   */
  pickVariant(item: GroupedCartItem, option: { variant_id: string; size?: string; color?: string }): void {
    if (option.variant_id === item.variant_id) {
      this.editingVariantId.set(null);
      return;
    }
    this.cart.replaceVariant(item.variant_id, {
      variant_id: option.variant_id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_image: item.product_image,
      quantity: item.quantity,
      unit_price: item.unit_price,
      color: option.color,
      size: option.size,
    });
    this.selectedIds.update((ids) => ids.map((id) => (id === item.variant_id ? option.variant_id : id)));
    this.editingVariantId.set(null);
    this.variantChoices.set([]);
  }

  /**
   * Steps the original cart quantity control for a line or combo set.
   */
  changeQty(item: GroupedCartItem, delta: number): void {
    this.cart.updateQty(item.variant_id, item.quantity + delta);
    this.clampPage();
  }

  /**
   * Toggles one grouped row in the original selected-items list.
   */
  toggleItem(item: GroupedCartItem, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const next = checked
      ? [...this.selectedIds().filter((id) => id !== item.variant_id), item.variant_id]
      : this.selectedIds().filter((id) => id !== item.variant_id);
    this.selectedIds.set(next);
    this.persistSelected();
  }

  /**
   * Selects or clears every grouped cart row.
   */
  toggleAll(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedIds.set(checked ? this.groupedItems().map((item) => item.variant_id) : []);
    this.persistSelected();
  }

  /**
   * Moves to a cart page like the original 5-item pager.
   */
  goToPage(page: number): void {
    const next = Math.min(Math.max(1, page), this.totalPages());
    this.currentPage.set(next);
    document.querySelector('.cart-header')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onReferralInput(event: Event): void {
    this.referralCode.set((event.target as HTMLInputElement).value);
  }

  applyReferralCode(): void {
    const code = this.referralCode().trim();
    if (!code) {
      this.referralApplied.set(false);
      this.checkoutStore.saveShipping({ ...this.checkoutStore.shipping(), referral_code: '' });
      showToast('Đã xóa mã giới thiệu');
      return;
    }
    this.referralApplied.set(true);
    this.checkoutStore.saveShipping({ ...this.checkoutStore.shipping(), referral_code: code });
    showToast(`Đã ghi nhận mã giới thiệu: ${code}`);
  }

  /**
   * Starts checkout with the originally selected cart rows.
   */
  checkout(): void {
    const selected = this.selectedItems();
    if (!selected.length) {
      showToast('Vui lòng chọn ít nhất một sản phẩm để thanh toán.');
      return;
    }
    const expanded = this.cart.expandGroupedItems(selected);
    this.checkoutStore.setCheckoutItems(expanded);
    if (this.referralCode().trim()) {
      this.checkoutStore.saveShipping({ ...this.checkoutStore.shipping(), referral_code: this.referralCode().trim() });
    }
    sessionStorage.setItem(CHECKOUT_ITEMS_KEY, JSON.stringify(expanded));
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_code');
    // Mang lựa chọn mã sang trang thanh toán. Trước đây bước này xoá mã đi, nên mã khách
    // chọn ở giỏ bị ví ở trang thanh toán thay bằng mã tốt nhất mà không nói gì.
    const voucher = this.appliedVoucher();
    if (voucher) {
      localStorage.setItem(VOUCHER_ID_KEY, voucher.voucher_id);
    } else {
      localStorage.removeItem(VOUCHER_ID_KEY);
    }
    if (this.voucherDeclined()) {
      localStorage.setItem(VOUCHER_DECLINED_KEY, '1');
    } else {
      localStorage.removeItem(VOUCHER_DECLINED_KEY);
    }
    void this.router.navigateByUrl('/checkout/shipping');
  }

  /**
   * Returns whether a grouped row is currently selected.
   */
  isSelected(item: GroupedCartItem): boolean {
    return this.selectedIds().includes(item.variant_id);
  }

  private clampPage(): void {
    const total = Math.max(1, Math.ceil(this.groupedItems().length / ITEMS_PER_PAGE));
    if (this.currentPage() > total) {
      this.currentPage.set(total);
    }
    this.syncSelection(this.groupedItems());
  }

  private syncSelection(items: GroupedCartItem[]): void {
    const valid = new Set(items.map((item) => item.variant_id));
    if (!this.hadStoredSelection) {
      this.selectedIds.set(items.map((item) => item.variant_id));
      this.persistSelected();
      return;
    }
    this.selectedIds.set(this.selectedIds().filter((id) => valid.has(id)));
    this.persistSelected();
  }

  private persistSelected(): void {
    sessionStorage.setItem(SELECTED_KEY, JSON.stringify(this.selectedIds()));
    this.hadStoredSelection = true;
  }

  private readSelectedIds(): string[] {
    try {
      const raw = JSON.parse(sessionStorage.getItem(SELECTED_KEY) || '[]') as unknown;
      return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
    } catch {
      return [];
    }
  }
}
