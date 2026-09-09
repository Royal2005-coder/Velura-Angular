import { Component, computed, inject, signal } from '@angular/core';
import { AdminApiService, AdminPriceHistoryRow, AdminProductRow } from '../../core/admin-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type PriceStatus = '' | 'discount' | 'invalid' | 'missing';

@Component({
  selector: 'app-admin-pricing-page',
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-pricing.page.html',
})
export class AdminPricingPage {
  private readonly api = inject(AdminApiService);

  readonly products = signal<AdminProductRow[]>([]);
  readonly history = signal<AdminPriceHistoryRow[]>([]);
  readonly query = signal('');
  readonly category = signal('');
  readonly status = signal<PriceStatus>('');
  readonly showHistory = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly selected = signal<AdminProductRow | null>(null);
  readonly actionOpen = signal(false);
  readonly detailOpen = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly previewBase = signal(0);
  readonly previewSale = signal(0);

  readonly categories = computed(() => {
    const names = this.products()
      .map((row) => row.category?.name || row.category_name)
      .filter((name): name is string => Boolean(name));
    return [...new Set(names)];
  });
  readonly missingSale = computed(() => this.products().filter((row) => row.sale_price == null).length);
  readonly discounted = computed(() => this.products().filter((row) => this.discountPct(row) > 0).length);
  readonly invalid = computed(() => this.products().filter((row) => Number(row.sale_price) > Number(row.base_price)).length);
  readonly historyToday = computed(() => {
    const today = new Date().toDateString();
    return this.history().filter((row) => row.changed_at && new Date(row.changed_at).toDateString() === today).length;
  });
  readonly filtered = computed(() => {
    const query = this.query().toLowerCase();
    const category = this.category();
    const status = this.status();
    return this.products().filter((row) => {
      if (query && !`${row.name} ${row.sku || ''}`.toLowerCase().includes(query)) {
        return false;
      }
      if (category && (row.category?.name || row.category_name) !== category) {
        return false;
      }
      if (status === 'discount' && this.discountPct(row) <= 0) {
        return false;
      }
      if (status === 'invalid' && !(Number(row.sale_price) > Number(row.base_price))) {
        return false;
      }
      if (status === 'missing' && row.sale_price != null) {
        return false;
      }
      return true;
    });
  });
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize)));
  readonly paged = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.filtered().slice(start, start + this.pageSize);
  });
  readonly rangeLabel = computed(() => {
    const total = this.filtered().length;
    if (!total) {
      return 'Hiển thị 0 - 0 / 0 sản phẩm';
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} sản phẩm`;
  });
  readonly previewPct = computed(() => this.discountFromPrices(this.previewBase(), this.previewSale()));
  readonly previewInvalid = computed(() => this.previewSale() > this.previewBase());

  constructor() {
    this.reload();
  }

  /**
   * Reloads catalog prices and price history.
   */
  reload(): void {
    this.api.listProducts({ limit: '100' }).subscribe({
      next: (payload) => this.products.set(adminListRows(payload)),
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
    this.api.listPriceHistory({ limit: '100' }).subscribe({
      next: (payload) => this.history.set(adminListRows(payload)),
    });
  }

  /**
   * Applies the original pricing filter bar.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.category.set((form.elements.namedItem('category') as HTMLSelectElement | null)?.value || '');
    this.status.set(((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '') as PriceStatus);
    this.page.set(1);
  }

  /**
   * Clears the original pricing filters.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.category.set('');
    this.status.set('');
    this.page.set(1);
  }

  /**
   * Moves pricing pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
  }

  /**
   * Opens the original price detail drawer.
   */
  openDetail(productId: string): void {
    this.selected.set(this.products().find((row) => row.product_id === productId) || null);
    this.detailOpen.set(true);
    this.actionOpen.set(false);
  }

  /**
   * Opens the original change-price modal.
   */
  openChange(productId: string): void {
    const row = this.products().find((item) => item.product_id === productId) || null;
    this.selected.set(row);
    this.previewBase.set(Number(row?.base_price || 0));
    this.previewSale.set(Number(row?.sale_price ?? row?.base_price ?? 0));
    this.actionOpen.set(true);
    this.detailOpen.set(false);
    this.actionError.set(null);
  }

  /**
   * Closes drawers and price modals.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionOpen.set(false);
    this.detailOpen.set(false);
    this.actionError.set(null);
  }

  /**
   * Updates the live price preview.
   */
  onPreviewInput(event: Event, field: 'base' | 'sale'): void {
    const value = Number((event.target as HTMLInputElement).value || 0);
    if (field === 'base') {
      this.previewBase.set(value);
    } else {
      this.previewSale.set(value);
    }
  }

  /**
   * Submits a price change through the original pricing API.
   */
  submitPrice(event: Event): void {
    event.preventDefault();
    const row = this.selected();
    if (!row || !row.version) {
      this.actionError.set('Thiếu phiên bản sản phẩm để cập nhật giá.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const newBasePrice = Number((form.elements.namedItem('basePrice') as HTMLInputElement).value);
    const newSalePrice = Number((form.elements.namedItem('salePrice') as HTMLInputElement).value);
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement).value.trim();
    if (newSalePrice > newBasePrice) {
      this.actionError.set('Giá bán không được cao hơn giá gốc');
      return;
    }
    this.api.changePrice(row.product_id, { newBasePrice, newSalePrice, reason, expectedVersion: row.version }).subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Formats a catalog price.
   */
  money(value: number | undefined | null): string {
    return adminMoney(value);
  }

  /**
   * Discount percent for the original price table.
   */
  discount(product: AdminProductRow): string {
    const pct = this.discountPct(product);
    if (pct > 0) {
      return `-${pct}%`;
    }
    return product.sale_price != null ? '0%' : '—';
  }

  /**
   * Numeric discount used by KPIs and filters.
   */
  discountPct(product: AdminProductRow): number {
    return this.discountFromPrices(Number(product.base_price || 0), Number(product.sale_price ?? product.base_price ?? 0));
  }

  /**
   * Whether sale price is above base price.
   */
  isInvalid(product: AdminProductRow): boolean {
    return Number(product.sale_price) > Number(product.base_price);
  }

  /**
   * Category name used by the original table.
   */
  categoryName(product: AdminProductRow): string {
    return product.category?.name || product.category_name || '—';
  }

  /**
   * Formats a pricing timestamp.
   */
  date(value: string | undefined | null): string {
    return adminDateTime(value);
  }

  /**
   * Status badge for the original price table.
   */
  statusLabel(status: string | undefined): string {
    return status === 'on_sale' ? 'Đang bán' : 'Tạm ẩn';
  }

  private discountFromPrices(basePrice: number, salePrice: number): number {
    return basePrice > salePrice && basePrice > 0 ? Math.round(((basePrice - salePrice) * 100) / basePrice) : 0;
  }
}
