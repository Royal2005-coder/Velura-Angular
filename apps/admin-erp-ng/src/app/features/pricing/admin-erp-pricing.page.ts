import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, of } from 'rxjs';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminPriceHistoryRow,
  AdminProductRow,
} from '../../core/admin-erp-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type PricingTab = 'prices' | 'history' | 'logs';
type PriceState = '' | 'discount' | 'invalid' | 'missing';

const EMPTY_PRODUCTS = { rows: [] as AdminProductRow[], count: 0 };
const EMPTY_HISTORY = { rows: [] as AdminPriceHistoryRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

/**
 * Price workspace. Reads the catalog price list and history; writes only through
 * `change-price` with expectedVersion and an operator reason.
 */
@Component({
  selector: 'app-admin-erp-pricing-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpModal,
    AdminErpStatusBadge,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-pricing.page.html',
  styleUrl: './admin-erp-pricing.page.scss',
})
export class AdminErpPricingPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly tab = signal<PricingTab>('prices');
  readonly products = signal<AdminProductRow[]>([]);
  readonly history = signal<AdminPriceHistoryRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly query = signal('');
  readonly status = signal('');
  readonly priceState = signal<PriceState>('');
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly historyCount = signal(0);
  readonly logsCount = signal(0);
  readonly selected = signal<AdminProductRow | null>(null);
  readonly actionOpen = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly previewBase = signal(0);
  readonly previewSale = signal(0);
  readonly canMutate = computed(() => this.session.can('update', 'pricing'));

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'prices', label: 'Bảng giá', count: this.total() },
    { key: 'history', label: 'Lịch sử giá', count: this.historyCount() },
    { key: 'logs', label: 'Nhật ký' },
  ]);
  readonly missingSale = computed(() => this.products().filter((row) => row.sale_price == null).length);
  readonly discounted = computed(() => this.products().filter((row) => this.discountPct(row) > 0).length);
  readonly invalid = computed(() => this.products().filter((row) => this.isInvalid(row)).length);
  readonly historyToday = computed(() => {
    const today = new Date().toDateString();
    return this.history().filter((row) => row.changed_at && new Date(row.changed_at).toDateString() === today).length;
  });
  readonly filtered = computed(() => {
    const state = this.priceState();
    if (!state) return this.products();
    if (state === 'discount') return this.products().filter((row) => this.discountPct(row) > 0);
    if (state === 'invalid') return this.products().filter((row) => this.isInvalid(row));
    return this.products().filter((row) => row.sale_price == null);
  });
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'sản phẩm'));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));
  readonly previewPct = computed(() => this.discountFromPrices(this.previewBase(), this.previewSale()));
  readonly previewInvalid = computed(() => this.previewSale() > this.previewBase());
  readonly statusOptions = [
    { value: '', label: 'Tất cả trạng thái' },
    { value: 'on_sale', label: 'Đang bán' },
    { value: 'hidden', label: 'Tạm ẩn' },
    { value: 'out_of_stock', label: 'Hết hàng' },
    { value: 'discontinued', label: 'Ngừng bán' },
  ];
  readonly priceStateOptions = [
    { value: '', label: 'Mọi mức giá' },
    { value: 'discount', label: 'Đang giảm giá' },
    { value: 'invalid', label: 'Giá bán > giá gốc' },
    { value: 'missing', label: 'Chưa có giá bán' },
  ];

  readonly priceColumns: readonly AdminTableColumn[] = [
    {
      key: 'product',
      label: 'Sản phẩm',
      value: (row) => {
        const product = row as AdminProductRow;
        return `${product.name}${product.sku ? ' · ' + product.sku : ''}`;
      },
    },
    { key: 'category', label: 'Danh mục', value: (row) => this.categoryName(row as AdminProductRow) },
    { key: 'base', label: 'Giá gốc', value: (row) => this.money((row as AdminProductRow).base_price), mono: true, align: 'right' },
    { key: 'sale', label: 'Giá bán', value: (row) => this.money((row as AdminProductRow).sale_price), mono: true, align: 'right' },
    {
      key: 'discount',
      label: 'Giảm',
      value: (row) => this.discount(row as AdminProductRow),
      badge: (row) => {
        const pct = this.discountPct(row as AdminProductRow);
        return pct > 0 ? { label: `-${pct}%`, tone: 'success' as const } : null;
      },
      align: 'right',
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => this.statusLabel((row as AdminProductRow).status),
      badge: (row) => ({ label: this.statusLabel((row as AdminProductRow).status), tone: this.statusTone((row as AdminProductRow).status) }),
    },
    { key: 'updated', label: 'Cập nhật', value: (row) => this.date((row as AdminProductRow).updated_at) },
  ];

  readonly historyColumns: readonly AdminTableColumn[] = [
    { key: 'date', label: 'Thời gian', value: (row) => this.date((row as AdminPriceHistoryRow).changed_at) },
    { key: 'product', label: 'Sản phẩm', value: (row) => this.historyProductName(row as AdminPriceHistoryRow) },
    { key: 'base', label: 'Giá gốc', value: (row) => `${this.money((row as AdminPriceHistoryRow).old_base_price)} → ${this.money((row as AdminPriceHistoryRow).new_base_price)}` },
    { key: 'sale', label: 'Giá bán', value: (row) => `${this.money((row as AdminPriceHistoryRow).old_sale_price)} → ${this.money((row as AdminPriceHistoryRow).new_sale_price)}` },
    { key: 'reason', label: 'Lý do', value: (row) => (row as AdminPriceHistoryRow).reason || '—' },
    { key: 'actor', label: 'Người thao tác', value: (row) => (row as AdminPriceHistoryRow).changed_by || '—' },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => (row as AdminAuditRow).action_label || (row as AdminAuditRow).action || '—' },
    { key: 'target', label: 'Đối tượng', value: (row) => (row as AdminAuditRow).target_label || (row as AdminAuditRow).target_id || '—' },
  ];

  constructor() {
    this.reload();
  }

  /**
   * Loads the active pricing tab.
   */
  reload(): void {
    if (this.tab() === 'history') {
      this.loadHistory();
      return;
    }
    if (this.tab() === 'logs') {
      this.loadLogs();
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .listPricingProducts({ q: this.query(), status: this.status(), limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) })
      .subscribe({
        next: (payload) => {
          this.products.set(adminListRows(payload));
          this.total.set(adminListCount(payload));
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được bảng giá.'));
          this.products.set([]);
          this.total.set(0);
          this.loading.set(false);
        },
      });
  }

  /**
   * Loads recent price history.
   */
  loadHistory(): void {
    this.loading.set(true);
    this.api.listPriceHistory({ limit: '50' }).subscribe({
      next: (payload) => {
        this.history.set(adminListRows(payload));
        this.historyCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được lịch sử giá.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Loads pricing audit rows.
   */
  loadLogs(): void {
    this.loading.set(true);
    this.api.listPricingAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký giá.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Switches pricing tabs.
   */
  setTab(tab: string): void {
    if (!['prices', 'history', 'logs'].includes(tab)) {
      return;
    }
    this.tab.set(tab as PricingTab);
    this.closeOverlays();
    this.reload();
  }

  /**
   * Applies server-side product filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears product filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.status.set('');
    this.priceState.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves price-list paging.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Moves pricing-audit paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.max(1, page));
    this.loadLogs();
  }

  /**
   * Opens the product price drawer.
   */
  openDetail(row: unknown): void {
    this.selected.set(row as AdminProductRow);
    this.actionOpen.set(false);
  }

  /**
   * Opens the change-price modal.
   */
  openChange(): void {
    const row = this.selected();
    if (!this.canMutate() || !row) {
      return;
    }
    this.previewBase.set(Number(row.base_price || 0));
    this.previewSale.set(Number(row.sale_price ?? row.base_price ?? 0));
    this.actionOpen.set(true);
    this.actionError.set(null);
  }

  /**
   * Closes drawer and modal.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionOpen.set(false);
    this.actionError.set(null);
  }

  /**
   * Updates the live price preview.
   */
  onPreviewInput(event: Event, field: 'base' | 'sale'): void {
    const value = Number((event.target as HTMLInputElement).value || 0);
    if (field === 'base') this.previewBase.set(value);
    else this.previewSale.set(value);
  }

  /**
   * Submits a price change with expectedVersion and reason.
   */
  submitPrice(event: Event): void {
    event.preventDefault();
    const row = this.selected();
    if (!row || !row.version) {
      this.actionError.set('Thiếu phiên bản sản phẩm để cập nhật giá.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const newBasePrice = Number(this.field(form, 'basePrice').value);
    const newSalePrice = Number(this.field(form, 'salePrice').value);
    const reason = this.field(form, 'reason').value.trim();
    if (newSalePrice > newBasePrice) {
      this.actionError.set('Giá bán không được cao hơn giá gốc.');
      return;
    }
    if (reason.length < 10) {
      this.actionError.set('Lý do cần tối thiểu 10 ký tự.');
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
   * Updates the query filter.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the product status filter.
   */
  onStatusChange(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the client-side price-state filter for the current page.
   */
  onPriceStateChange(event: Event): void {
    this.priceState.set((event.target as HTMLSelectElement).value as PriceState);
  }

  /**
   * Money formatter.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Discount label.
   */
  discount(product: AdminProductRow): string {
    const pct = this.discountPct(product);
    if (pct > 0) return `-${pct}%`;
    return product.sale_price != null ? '0%' : '—';
  }

  /**
   * Discount percent.
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
   * Category label.
   */
  categoryName(product: AdminProductRow): string {
    return product.category?.name || product.category_name || '—';
  }

  /**
   * Product status label.
   */
  statusLabel(status: string | undefined): string {
    const labels: Record<string, string> = {
      on_sale: 'Đang bán',
      hidden: 'Tạm ẩn',
      out_of_stock: 'Hết hàng',
      discontinued: 'Ngừng bán',
    };
    return status ? labels[status] || status : '—';
  }

  /**
   * Product status tone.
   */
  statusTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'on_sale') return 'success';
    if (status === 'hidden') return 'warning';
    if (status === 'out_of_stock' || status === 'discontinued') return 'danger';
    return 'neutral';
  }

  /**
   * History product name.
   */
  historyProductName(row: AdminPriceHistoryRow): string {
    return row.product?.name || row.product_id || '—';
  }

  /**
   * Timestamp formatter.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Audit actor label.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  private discountFromPrices(basePrice: number, salePrice: number): number {
    return basePrice > salePrice && basePrice > 0 ? Math.round(((basePrice - salePrice) * 100) / basePrice) : 0;
  }

  private field(form: HTMLFormElement, name: string): HTMLInputElement {
    return (form.elements.namedItem(name) as HTMLInputElement | null) ?? document.createElement('input');
  }
}
