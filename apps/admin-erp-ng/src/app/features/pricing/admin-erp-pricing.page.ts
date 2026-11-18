import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminPriceHistoryRow,
  AdminProductRow,
} from '../../core/admin-erp-api.service';
import { PRODUCT_STATUSES } from '../../core/admin-erp-catalog';
import { type ListQuery, choiceParam, queryMatches, textParam, watchQueryParams, writeQueryParams } from '../../core/admin-erp-deep-link';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import { AdminErpDataTable, AdminTableColumn, AdminTableRowAction } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';
import { PriceChangeFormComponent } from './price-change-form.component';

type PricingTab = 'prices' | 'history' | 'logs';
type PriceState = '' | 'discount' | 'invalid' | 'missing';

const PRICING_TABS: readonly string[] = ['prices', 'history', 'logs'];
const PRICE_STATES: readonly string[] = ['discount', 'invalid', 'missing'];
const PAGE_SIZES: readonly number[] = [10, 20, 50];
const DEFAULT_PAGE_SIZE = 10;

/**
 * Price workspace. Reads the catalog price list and history; writes only through
 * `change-price` with expectedVersion and an operator reason (shared {@link PriceChangeFormComponent}).
 * Tab, filters, page and page size live in the URL so Back, refresh and shared links keep the view.
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
    AdminErpStatusBadge,
    AdminErpIcon,
    PriceChangeFormComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-pricing.page.html',
  styleUrl: './admin-erp-pricing.page.scss',
})
export class AdminErpPricingPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  /** The first URL has been applied; later identical URLs are our own echoes. */
  private urlApplied = false;

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
  readonly pageSize = signal(DEFAULT_PAGE_SIZE);
  readonly pageSizes = PAGE_SIZES;
  readonly total = signal(0);
  readonly historyCount = signal(0);
  readonly logsCount = signal(0);
  /** Product shown in the detail drawer. */
  readonly selected = signal<AdminProductRow | null>(null);
  /** Product whose price form is open (from the drawer or straight from a row action). */
  readonly priceTarget = signal<AdminProductRow | null>(null);
  readonly selectedLog = signal<AdminAuditRow | null>(null);
  readonly canMutate = computed(() => this.session.can('update', 'pricing'));

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'prices', label: 'Bảng giá', count: this.total() },
    { key: 'history', label: 'Lịch sử giá', count: this.historyCount() },
    { key: 'logs', label: 'Nhật ký', count: this.logsCount() },
  ]);
  readonly missingSale = computed(() => this.products().filter((row) => row.sale_price == null).length);
  readonly discounted = computed(() => this.products().filter((row) => this.discountPct(row) > 0).length);
  readonly invalid = computed(() => this.products().filter((row) => this.isInvalid(row)).length);
  readonly historyToday = computed(() => {
    const today = new Date().toDateString();
    return this.history().filter((row) => row.changed_at && new Date(row.changed_at).toDateString() === today).length;
  });
  readonly filtered = computed(() => this.products());
  readonly hasFilters = computed(() => Boolean(this.query() || this.status() || this.priceState()));
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize())));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize(), 'sản phẩm'));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize(), 'nhật ký'));
  /** Position of the drawer's product in the visible page, for ‹ › / J K navigation. */
  private readonly selectedIndex = computed(() => {
    const id = this.selected()?.product_id;
    return id ? this.products().findIndex((row) => row.product_id === id) : -1;
  });
  readonly hasPrev = computed(() => this.selectedIndex() > 0);
  readonly hasNext = computed(() => {
    const index = this.selectedIndex();
    return index >= 0 && index < this.products().length - 1;
  });
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
      icon: 'box',
      truncate: '270px',
      value: (row) => (row as AdminProductRow).name,
      subtext: (row) => (row as AdminProductRow).sku || '',
      copyValue: (row) => (row as AdminProductRow).sku || '',
    },
    { key: 'category', label: 'Danh mục', icon: 'layers', value: (row) => this.categoryName(row as AdminProductRow) },
    { key: 'base', label: 'Giá gốc', icon: 'coins', value: (row) => this.money((row as AdminProductRow).base_price), mono: true, align: 'right' },
    { key: 'sale', label: 'Giá bán', icon: 'tag', value: (row) => this.money((row as AdminProductRow).sale_price), mono: true, align: 'right' },
    {
      key: 'discount',
      label: 'Giảm',
      icon: 'percent',
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
      icon: 'activity',
      value: (row) => this.statusLabel((row as AdminProductRow).status),
      badge: (row) => ({ label: this.statusLabel((row as AdminProductRow).status), tone: this.statusTone((row as AdminProductRow).status) }),
    },
    { key: 'updated', label: 'Cập nhật', icon: 'calendar', mono: true, value: (row) => this.date((row as AdminProductRow).updated_at) },
  ];

  readonly historyColumns: readonly AdminTableColumn[] = [
    { key: 'date', label: 'Thời gian', icon: 'clock', mono: true, value: (row) => this.date((row as AdminPriceHistoryRow).changed_at) },
    { key: 'product', label: 'Sản phẩm', icon: 'box', truncate: '240px', value: (row) => this.historyProductName(row as AdminPriceHistoryRow) },
    { key: 'base', label: 'Giá gốc', icon: 'coins', mono: true, value: (row) => `${this.money((row as AdminPriceHistoryRow).old_base_price)} → ${this.money((row as AdminPriceHistoryRow).new_base_price)}` },
    { key: 'sale', label: 'Giá bán', icon: 'tag', mono: true, value: (row) => `${this.money((row as AdminPriceHistoryRow).old_sale_price)} → ${this.money((row as AdminPriceHistoryRow).new_sale_price)}` },
    { key: 'reason', label: 'Lý do', truncate: '260px', value: (row) => (row as AdminPriceHistoryRow).reason || '—' },
    { key: 'actor', label: 'Người thao tác', icon: 'user', value: (row) => (row as AdminPriceHistoryRow).changed_by || '—' },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', icon: 'clock', mono: true, value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', icon: 'user', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', icon: 'activity', value: (row) => (row as AdminAuditRow).action_label || (row as AdminAuditRow).action || '—' },
    { key: 'target', label: 'Đối tượng', icon: 'hash', truncate: '280px', value: (row) => (row as AdminAuditRow).target_label || (row as AdminAuditRow).target_id || '—' },
  ];

  /** Stable row identity so a reload keeps keyboard focus on the same product. */
  readonly productRowId = (row: unknown): string => (row as AdminProductRow).product_id;

  /** One-click "Đổi giá" per row: opens the shared price form without the drawer. */
  readonly priceRowActions = (row: unknown): readonly AdminTableRowAction[] =>
    this.canMutate() ? [{ label: 'Đổi giá', icon: 'coins', tone: 'outline', run: () => this.openChangeFor(row as AdminProductRow) }] : [];

  constructor() {
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    this.loadInitialCounts();
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Preloads count for history and audit logs so subtab badges show real numbers immediately.
   */
  loadInitialCounts(): void {
    forkJoin({
      history: this.api.listPriceHistory({ limit: '1' }).pipe(catchError(() => of({ rows: [], count: 0 }))),
      logs: this.api.listPricingAuditLogs({ limit: '1' }).pipe(catchError(() => of({ rows: [], count: 0 }))),
    }).subscribe((payload) => {
      if (this.tab() !== 'history') {
        this.historyCount.set(adminListCount(payload.history));
      }
      if (this.tab() !== 'logs') {
        this.logsCount.set(adminListCount(payload.logs));
      }
    });
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
    const params: Record<string, string> = {
      q: this.query(),
      status: this.status(),
      limit: String(this.pageSize()),
      offset: adminOffset(this.page(), this.pageSize()),
    };
    const state = this.priceState();
    if (state === 'discount') params['price_state'] = 'discounted';
    else if (state === 'invalid') params['price_state'] = 'invalid';
    else if (state === 'missing') params['price_state'] = 'missing_sale';
    this.api
      .listPricingProducts(params)
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
   * Loads recent price history (the API returns the 50 latest changes).
   */
  loadHistory(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.listPriceHistory({ limit: '50' }).subscribe({
      next: (payload) => {
        this.history.set(adminListRows(payload));
        this.historyCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được lịch sử giá.'));
        this.history.set([]);
        this.loading.set(false);
      },
    });
  }

  /**
   * Loads pricing audit rows.
   */
  loadLogs(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.listPricingAuditLogs({ limit: String(this.pageSize()), offset: adminOffset(this.logsPage(), this.pageSize()) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký giá.'));
        this.logs.set([]);
        this.logsCount.set(0);
        this.loading.set(false);
      },
    });
  }

  /**
   * Switches pricing tabs, starting the new tab at page 1.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!PRICING_TABS.includes(tab)) {
      return;
    }
    this.tab.set(tab as PricingTab);
    this.page.set(1);
    this.logsPage.set(1);
    this.closeDetail();
    this.selectedLog.set(null);
    this.syncUrl();
    this.reload();
  }

  /**
   * Applies server-side product filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.syncUrl();
    this.reload();
  }

  /**
   * Clears every product filter.
   */
  resetFilters(): void {
    this.query.set('');
    this.status.set('');
    this.priceState.set('');
    this.page.set(1);
    this.syncUrl();
    this.reload();
  }

  /**
   * Moves price-list paging.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.syncUrl();
    this.reload();
  }

  /**
   * Moves pricing-audit paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.max(1, page));
    this.syncUrl();
    this.loadLogs();
  }

  /**
   * Changes rows per page for the price list and the audit list, restarting at page 1.
   */
  setPageSize(size: number): void {
    if (!PAGE_SIZES.includes(size)) {
      return;
    }
    this.pageSize.set(size);
    this.page.set(1);
    this.logsPage.set(1);
    this.syncUrl();
    this.reload();
  }

  /**
   * Opens the product price drawer.
   */
  openDetail(row: unknown): void {
    this.selected.set(row as AdminProductRow);
  }

  /**
   * Moves the drawer to the previous product of the visible page.
   */
  showPrev(): void {
    const row = this.products()[this.selectedIndex() - 1];
    if (row) this.selected.set(row);
  }

  /**
   * Moves the drawer to the next product of the visible page.
   */
  showNext(): void {
    const row = this.products()[this.selectedIndex() + 1];
    if (row) this.selected.set(row);
  }

  /**
   * Opens the change-price form for the drawer's product.
   */
  openChange(): void {
    const row = this.selected();
    if (row) this.openChangeFor(row);
  }

  /**
   * Opens the change-price form for one product (drawer button or row action).
   */
  openChangeFor(row: AdminProductRow): void {
    if (!this.canMutate()) {
      return;
    }
    this.priceTarget.set(row);
  }

  /**
   * Closes only the price form; the drawer behind it stays on the same product.
   */
  closeChange(): void {
    this.priceTarget.set(null);
  }

  /**
   * Shows the saved prices in the open drawer and refreshes the list and KPIs.
   */
  onPriceSaved(updated: AdminProductRow): void {
    const targetId = this.priceTarget()?.product_id;
    this.priceTarget.set(null);
    const current = this.selected();
    if (current && current.product_id === targetId) {
      this.selected.set({ ...current, ...updated });
    }
    this.reload();
  }

  /**
   * Closes the drawer (and a price form opened from it).
   */
  closeDetail(): void {
    this.selected.set(null);
    this.priceTarget.set(null);
  }

  /**
   * Opens one pricing audit row.
   */
  openLog(row: unknown): void {
    this.selectedLog.set(row as AdminAuditRow);
  }

  /**
   * Closes the audit detail.
   */
  closeLog(): void {
    this.selectedLog.set(null);
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
   * Updates the server-side price-state filter.
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
    const basePrice = Number(product.base_price || 0);
    const salePrice = Number(product.sale_price ?? product.base_price ?? 0);
    return basePrice > salePrice && basePrice > 0 ? Math.round(((basePrice - salePrice) * 100) / basePrice) : 0;
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

  /**
   * Pretty-printed audit payload.
   */
  json(value: unknown): string {
    if (!value || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
      return 'Trống';
    }
    return JSON.stringify(value, null, 2);
  }

  /**
   * The URL is the source of truth for tab, filters, page and page size; our own writes echo back
   * here and are skipped.
   */
  private applyDeepLink(params: ParamMap): void {
    if (this.urlApplied && queryMatches(params, this.currentQuery())) return;
    this.urlApplied = true;
    this.tab.set(choiceParam(params, 'tab', PRICING_TABS, 'prices') as PricingTab);
    this.query.set(textParam(params, 'q'));
    this.status.set(choiceParam(params, 'status', PRODUCT_STATUSES));
    this.priceState.set(choiceParam(params, 'price', PRICE_STATES) as PriceState);
    this.pageSize.set(Number(choiceParam(params, 'size', PAGE_SIZES.map(String), String(DEFAULT_PAGE_SIZE))));
    const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
    this.page.set(this.tab() === 'prices' ? page : 1);
    this.logsPage.set(this.tab() === 'logs' ? page : 1);
    this.closeDetail();
    this.selectedLog.set(null);
    this.reload();
  }

  /** Every filter plus tab, page (of the active tab) and page size, neutral values blank. */
  private currentQuery(): ListQuery {
    const page = this.tab() === 'logs' ? this.logsPage() : this.tab() === 'prices' ? this.page() : 1;
    return {
      tab: this.tab() === 'prices' ? '' : this.tab(),
      q: this.query(),
      status: this.status(),
      price: this.priceState(),
      page: page > 1 ? page : '',
      size: this.pageSize() === DEFAULT_PAGE_SIZE ? '' : this.pageSize(),
    };
  }

  private syncUrl(): void {
    writeQueryParams(this.router, this.route, this.currentQuery());
  }
}
