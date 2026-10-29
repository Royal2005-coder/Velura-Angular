import { Subscription, catchError, forkJoin, of } from 'rxjs';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, type ParamMap } from '@angular/router';
import {
  AdminAuditRow,
  AdminCategoryRow,
  AdminErpApiService,
  AdminLowStockAlert,
  AdminLowStockRow,
  AdminProductRow,
  AdminProductVariant,
} from '../../core/admin-erp-api.service';
import {
  allowedStatusTransitions,
  lowStockVariants,
  productStatusLabel,
  productStatusTone,
  variantStockTotal,
  MIN_CHANGE_REASON_LENGTH,
  PRODUCT_AUDIT_ACTION_TYPES,
  PRODUCT_ORDER_OPTIONS,
  PRODUCT_STATUSES,
  PRODUCT_STATUS_HINTS,
} from '../../core/admin-erp-catalog';
import { choiceParam, textParam, watchQueryParams } from '../../core/admin-erp-deep-link';
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
import { AdminTone } from '../../core/admin-erp-status-labels';
import { AdminErpDataTable } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpLoadingOverlay } from '../../shared/ui/admin-loading-overlay';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';
import type { AdminTableColumn } from '../../shared/ui/admin-data-table';
import { ProductCsvImportComponent } from './product-csv-import.component';
import { ProductEditorComponent } from './product-editor.component';
import { ProductStockSheetComponent } from './product-stock-sheet.component';

type ProductsTab = 'catalog' | 'stock' | 'import' | 'logs';

const PRODUCTS_TABS: readonly string[] = ['catalog', 'stock', 'import', 'logs'];

const EMPTY_LIST = { rows: [] as AdminProductRow[], count: 0 };
const EMPTY_LOW_STOCK = { rows: [] as AdminLowStockRow[], count: 0 };
const PLACEHOLDER_IMAGE = '/assets/images/placeholder.jpg';

/**
 * Catalog workspace: server-paged products, variant-level stock, low-stock queue,
 * CSV import and product audit. Writes go through the catalog API only — price and
 * status keep their own audited endpoints, and every mutation carries `expectedVersion`.
 */
@Component({
  selector: 'app-admin-erp-products-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpLoadingOverlay,
    AdminErpModal,
    AdminErpStatusBadge,
    AdminErpIcon,
    ProductEditorComponent,
    ProductStockSheetComponent,
    ProductCsvImportComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-products.page.html',
  styleUrl: './admin-erp-products.page.scss',
})
export class AdminErpProductsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private listRequest = new Subscription();
  private detailRequest = new Subscription();
  private skuCheckRequest = new Subscription();

  readonly tab = signal<ProductsTab>('catalog');
  readonly products = signal<AdminProductRow[]>([]);
  readonly categories = signal<AdminCategoryRow[]>([]);
  readonly lowStockRows = signal<AdminLowStockRow[]>([]);
  readonly lowStockTotal = signal(0);
  readonly total = signal(0);
  readonly onSale = signal(0);
  readonly hidden = signal(0);
  readonly outOfStock = signal(0);
  readonly query = signal('');
  readonly categoryId = signal('');
  readonly status = signal('');
  readonly order = signal('updated_at.desc');
  readonly lowStockOnly = signal(false);
  readonly page = signal(1);
  readonly pageSize = 12;
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);

  /** Product shown in the detail drawer, with its variants re-read from the API. */
  readonly selected = signal<AdminProductRow | null>(null);
  readonly variants = signal<AdminProductVariant[]>([]);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  /** Low-stock alert from the last adjustment; kept visible even when its email waits for retry. */
  readonly stockAlert = signal<AdminLowStockAlert | null>(null);
  readonly editorProduct = signal<AdminProductRow | null | undefined>(undefined);
  readonly statusOpen = signal(false);
  readonly nextStatus = signal('');
  readonly statusError = signal<string | null>(null);
  readonly priceOpen = signal(false);
  readonly priceSaving = signal(false);
  readonly priceError = signal<string | null>(null);
  readonly stockOpen = signal(false);

  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsTotal = signal(0);
  readonly logsPage = signal(1);
  readonly logsLoading = signal(false);
  readonly logsError = signal<string | null>(null);
  readonly logsFrom = signal('');
  readonly logsTo = signal('');
  readonly logsProduct = signal('');
  readonly logsAction = signal('');
  readonly logsUser = signal('');
  readonly selectedLog = signal<AdminAuditRow | null>(null);

  readonly canRead = computed(() => this.session.can('read', 'products'));
  readonly canWrite = computed(() => this.session.can('update', 'products'));
  readonly canCreate = computed(() => this.session.can('create', 'products'));
  readonly canChangePrice = computed(() => this.session.can('update', 'pricing'));
  readonly canOpenPricing = computed(() => this.session.can('read', 'pricing'));
  readonly minReasonLength = MIN_CHANGE_REASON_LENGTH;

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'catalog', label: 'Danh mục', count: this.total() },
    { key: 'stock', label: 'Tồn kho', count: this.lowStockCount() },
    { key: 'import', label: 'Nhập CSV' },
    { key: 'logs', label: 'Nhật ký', count: this.logsTotal() },
  ]);

  readonly lowStockCount = computed(() => this.lowStockTotal());
  readonly featuredCount = computed(() => this.products().filter((row) => row.is_featured).length);
  readonly comboCount = computed(() => this.products().filter((row) => row.is_combo).length);
  readonly pageStock = computed(() =>
    this.products().reduce((sum, product) => sum + variantStockTotal(product.variants), 0),
  );
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly logsPageCount = computed(() => Math.max(1, Math.ceil(this.logsTotal() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'sản phẩm'));
  readonly logsRangeLabel = computed(() =>
    adminRangeLabel(this.logsTotal(), this.logsPage(), this.pageSize, 'nhật ký'),
  );
  readonly showSkeleton = computed(() => this.loading() && !this.hasLoadedOnce());
  readonly isRefreshing = computed(() => this.loading() && this.hasLoadedOnce());
  readonly selectedVariants = computed(() => lowStockVariants(this.variants()));
  readonly allowedStatuses = computed(() =>
    allowedStatusTransitions(this.selected()?.status).map((value) => ({
      value,
      label: productStatusLabel(value),
      hint: PRODUCT_STATUS_HINTS[value] || '',
    })),
  );
  readonly categoryOptions = computed(() => [
    { value: '', label: 'Tất cả danh mục' },
    ...this.categories().map((category) => ({ value: category.category_id, label: category.name })),
  ]);
  readonly statusOptions = [
    { value: '', label: 'Mọi trạng thái' },
    { value: 'on_sale', label: 'Đang bán' },
    { value: 'hidden', label: 'Tạm ẩn' },
    { value: 'out_of_stock', label: 'Hết hàng' },
    { value: 'discontinued', label: 'Ngừng kinh doanh' },
  ];
  readonly actionOptions = [
    { value: '', label: 'Mọi loại thao tác' },
    ...PRODUCT_AUDIT_ACTION_TYPES.map((value) => ({ value, label: auditActionLabel(value) })),
  ];
  readonly orderOptions = PRODUCT_ORDER_OPTIONS;

  readonly columns = computed<readonly AdminTableColumn[]>(() => [
    {
      key: 'product',
      label: 'Sản phẩm',
      width: '30%',
      image: (row) => primaryImage(row as AdminProductRow),
      value: (row) => {
        const product = row as AdminProductRow;
        return product.name;
      },
    },
    { key: 'sku', label: 'SKU', value: (row) => (row as AdminProductRow).sku || '—', mono: true },
    { key: 'category', label: 'Danh mục', value: (row) => this.categoryName(row as AdminProductRow) },
    {
      key: 'price',
      label: 'Giá bán',
      align: 'right',
      mono: true,
      value: (row) => this.money(salePrice(row as AdminProductRow)),
    },
    {
      key: 'stock',
      label: 'Tồn kho',
      align: 'right',
      mono: true,
      value: (row) => String(variantStockTotal((row as AdminProductRow).variants)),
      badge: (row) => {
        const low = lowStockVariants((row as AdminProductRow).variants).length;
        return low > 0 ? { label: `Sắp hết · ${low}`, tone: 'warning' as const } : null;
      },
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => productStatusLabel((row as AdminProductRow).status),
      badge: (row) => ({
        label: productStatusLabel((row as AdminProductRow).status),
        tone: productStatusTone((row as AdminProductRow).status),
      }),
    },
    {
      key: 'flags',
      label: 'Cờ',
      value: (row) => {
        const product = row as AdminProductRow;
        return [product.is_combo ? 'Combo' : '', product.is_featured ? 'Nổi bật' : '']
          .filter(Boolean)
          .join(' · ') || '—';
      },
    },
    { key: 'updated', label: 'Cập nhật', value: (row) => this.date((row as AdminProductRow).updated_at) },
  ]);

  readonly lowStockColumns = computed<readonly AdminTableColumn[]>(() => [
    {
      key: 'product',
      label: 'Sản phẩm',
      width: '28%',
      value: (row) => {
        const variant = row as AdminLowStockRow;
        return variant.product_name || variant.product_id;
      },
    },
    { key: 'sku', label: 'SKU cha', value: (row) => (row as AdminLowStockRow).product_sku || '—', mono: true },
    {
      key: 'variant',
      label: 'Biến thể',
      value: (row) => {
        const variant = row as AdminLowStockRow;
        return [variant.color, variant.size].filter(Boolean).join(' · ') || '—';
      },
    },
    {
      key: 'stock',
      label: 'Còn',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminLowStockRow).stock_quantity),
    },
    {
      key: 'threshold',
      label: 'Ngưỡng',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminLowStockRow).low_stock_threshold),
    },
    {
      key: 'shortage',
      label: 'Thiếu',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminLowStockRow).shortage ?? 0),
      badge: (row) => {
        const variant = row as AdminLowStockRow;
        return variant.out_of_stock
          ? { label: 'Hết hàng', tone: 'danger' as const }
          : { label: `Cần ${variant.shortage ?? 0}`, tone: 'warning' as const };
      },
    },
    {
      key: 'status',
      label: 'Trạng thái cha',
      value: (row) => productStatusLabel((row as AdminLowStockRow).product_status),
      badge: (row) => ({
        label: productStatusLabel((row as AdminLowStockRow).product_status),
        tone: productStatusTone((row as AdminLowStockRow).product_status),
      }),
    },
  ]);

  readonly logColumns = computed<readonly AdminTableColumn[]>(() => [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => this.logAction(row as AdminAuditRow) },
    { key: 'target', label: 'Đối tượng', value: (row) => this.logTarget(row as AdminAuditRow) },
    { key: 'change', label: 'Thay đổi', width: '24%', value: (row) => this.logChange(row as AdminAuditRow) },
    {
      key: 'result',
      label: 'Kết quả',
      value: (row) => this.logResult(row as AdminAuditRow),
      badge: (row) => ({ label: this.logResult(row as AdminAuditRow), tone: this.resultTone(row as AdminAuditRow) }),
    },
  ]);

  readonly variantColumns: readonly AdminTableColumn[] = [
    {
      key: 'variant',
      label: 'Biến thể',
      value: (row) => {
        const variant = row as AdminProductVariant;
        return [variant.color, variant.size].filter(Boolean).join(' · ') || variant.variant_id;
      },
    },
    { key: 'sku', label: 'SKU', value: (row) => (row as AdminProductVariant).sku || '—', mono: true },
    {
      key: 'stock',
      label: 'Còn',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).stock_quantity ?? 0),
    },
    {
      key: 'reserved',
      label: 'Giữ hàng',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).reserved_quantity ?? 0),
    },
    {
      key: 'threshold',
      label: 'Ngưỡng',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).low_stock_threshold ?? 0),
    },
    {
      key: 'state',
      label: 'Trạng thái',
      value: (row) => (isVariantLow(row as AdminProductVariant) ? 'Sắp hết' : 'Đủ hàng'),
      badge: (row) =>
        isVariantLow(row as AdminProductVariant)
          ? { label: 'Sắp hết', tone: 'warning' as const }
          : { label: 'Đủ hàng', tone: 'success' as const },
    },
  ];

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.listRequest.unsubscribe();
      this.detailRequest.unsubscribe();
      this.skuCheckRequest.unsubscribe();
    });
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    useWorkspaceRefresh(() => this.reload());
    this.api.listCategories().subscribe({
      next: (payload) => this.categories.set(adminListRows(payload)),
      error: () => this.categories.set([]),
    });
  }

  /**
   * Applies an inbound deep link: the queue tab and the catalog filters another workspace names.
   */
  private applyDeepLink(params: ParamMap): void {
    this.tab.set(choiceParam(params, 'tab', PRODUCTS_TABS, this.tab()) as ProductsTab);
    this.query.set(textParam(params, 'q'));
    this.status.set(choiceParam(params, 'status', PRODUCT_STATUSES, this.status()));
    this.page.set(1);
    this.reload();
  }

  /**
   * Loads the active tab.
   */
  reload(): void {
    if (this.tab() === 'logs') {
      this.loadLogs();
      return;
    }
    if (this.tab() === 'stock') {
      this.loadLowStock();
      return;
    }
    this.loadCatalog();
  }

  /**
   * Switches catalog / stock / import / audit tabs.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!PRODUCTS_TABS.includes(tab)) {
      return;
    }
    this.tab.set(tab as ProductsTab);
    this.reload();
  }

  /**
   * Applies the filter bar and returns to page 1.
   */
  applyFilters(): void {
    this.page.set(1);
    this.loadCatalog();
  }

  /**
   * Clears every catalog filter.
   */
  resetFilters(): void {
    this.query.set('');
    this.categoryId.set('');
    this.status.set('');
    this.order.set('updated_at.desc');
    this.lowStockOnly.set(false);
    this.page.set(1);
    this.loadCatalog();
  }

  /**
   * Toggles the low-stock filter from its KPI card.
   */
  toggleLowStockFilter(): void {
    this.lowStockOnly.update((value) => !value);
    this.page.set(1);
    this.loadCatalog();
  }

  /**
   * Moves catalog paging.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
    this.loadCatalog();
  }

  /**
   * Moves product-audit paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logsPageCount(), Math.max(1, page)));
    this.loadLogs();
  }

  /**
   * Opens the detail drawer and re-reads the product with its variants.
   */
  openDetail(row: unknown): void {
    this.openDetailById((row as AdminProductRow).product_id);
  }

  /**
   * Opens the drawer from a low-stock row, which carries only the parent id.
   */
  openLowStockDetail(row: unknown): void {
    this.openDetailById((row as AdminLowStockRow).product_id);
  }

  /**
   * Opens the create editor; `undefined` distinguishes create from the null used by a closed drawer.
   */
  openCreate(): void {
    if (!this.canCreate()) {
      return;
    }
    this.editorProduct.set(null);
  }

  /**
   * Opens the editor for the drawer's product.
   */
  openEdit(): void {
    const product = this.selected();
    if (!product || !this.canWrite()) {
      return;
    }
    this.editorProduct.set(product);
  }

  /**
   * Closes the editor and refreshes the catalog with the saved row.
   */
  onEditorSaved(product: AdminProductRow): void {
    this.editorProduct.set(undefined);
    if (this.selected()?.product_id === product.product_id) {
      this.openDetailById(product.product_id);
    }
    this.loadCatalog();
  }

  /**
   * Dismisses the editor without touching data.
   */
  closeEditor(): void {
    this.editorProduct.set(undefined);
  }

  /**
   * Opens the stock adjustment sheet for the drawer's product.
   */
  openStock(): void {
    if (!this.selected() || !this.canWrite()) {
      return;
    }
    this.stockAlert.set(null);
    this.stockOpen.set(true);
  }

  /**
   * Closes the stock sheet.
   */
  closeStock(): void {
    this.stockOpen.set(false);
  }

  /**
   * Shows the alert raised by a committed adjustment and rereads stock.
   */
  onStockAdjusted(alert: AdminLowStockAlert | null): void {
    this.stockAlert.set(alert);
    this.stockOpen.set(false);
    this.openDetailById(this.selected()?.product_id || '');
    this.loadCatalog();
  }

  /**
   * Opens the status modal with the first legal transition selected.
   */
  openStatus(): void {
    const product = this.selected();
    if (!product || !this.canWrite()) {
      return;
    }
    const options = allowedStatusTransitions(product.status);
    this.nextStatus.set(options[0] || 'hidden');
    this.statusError.set(null);
    this.statusOpen.set(true);
  }

  /**
   * Closes drawer, modals and the audit detail.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.variants.set([]);
    this.statusOpen.set(false);
    this.priceOpen.set(false);
    this.stockOpen.set(false);
    this.selectedLog.set(null);
    this.detailError.set(null);
    this.statusError.set(null);
    this.priceError.set(null);
    this.detailRequest.unsubscribe();
  }

  /**
   * Chooses the destination status.
   */
  chooseStatus(status: string): void {
    if (allowedStatusTransitions(this.selected()?.status).includes(status)) {
      this.nextStatus.set(status);
    }
  }

  /**
   * Applies a status transition through the catalog state machine.
   */
  submitStatus(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    const form = event.target as HTMLFormElement;
    const reason = field(form, 'reason').trim();
    if (!product || product.version == null) {
      this.statusError.set('Thiếu phiên bản sản phẩm để đổi trạng thái.');
      return;
    }
    if (reason.length < MIN_CHANGE_REASON_LENGTH) {
      this.statusError.set(`Lý do cần tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự.`);
      return;
    }
    this.api
      .changeProductStatus(product.product_id, {
        status: this.nextStatus(),
        reason,
        expectedVersion: product.version,
      })
      .subscribe({
        next: (updated) => {
          this.statusOpen.set(false);
          this.selected.set(updated);
          this.loadCatalog();
        },
        error: (error: unknown) => this.statusError.set(adminErrorMessage(error)),
      });
  }

  /**
   * Opens the price form for the drawer's product.
   */
  openPrice(): void {
    const product = this.selected();
    if (!product || !this.canChangePrice()) {
      return;
    }
    this.priceError.set(null);
    this.priceOpen.set(true);
  }

  /**
   * Writes a price change with the version read in the drawer.
   */
  submitPrice(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    const form = event.target as HTMLFormElement;
    const basePrice = Number(field(form, 'basePrice'));
    const saleRaw = field(form, 'salePrice');
    // Blank sale price means "no promotion": keep the selling price equal to the base price.
    const salePrice = saleRaw ? Number(saleRaw) : basePrice;
    const reason = field(form, 'reason').trim();
    if (!product || product.version == null) {
      this.priceError.set('Thiếu phiên bản sản phẩm để cập nhật giá.');
      return;
    }
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      this.priceError.set('Giá gốc phải lớn hơn 0.');
      return;
    }
    if (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice > basePrice) {
      this.priceError.set('Giá bán phải lớn hơn 0 và không vượt giá gốc.');
      return;
    }
    if (reason.length < MIN_CHANGE_REASON_LENGTH) {
      this.priceError.set(`Lý do cần tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự.`);
      return;
    }
    this.priceSaving.set(true);
    this.api
      .changePrice(product.product_id, {
        newBasePrice: basePrice,
        newSalePrice: salePrice,
        reason,
        expectedVersion: product.version,
      })
      .subscribe({
        next: (updated) => {
          this.priceSaving.set(false);
          this.priceOpen.set(false);
          this.selected.set({ ...(this.selected() || updated), ...updated });
          this.loadCatalog();
        },
        error: (error: unknown) => {
          this.priceSaving.set(false);
          this.priceError.set(adminErrorMessage(error));
        },
      });
  }

  /**
   * Reports a stale-lock conflict so the drawer rereads before another attempt.
   */
  onEditorConflict(): void {
    this.openDetailById(this.selected()?.product_id || '');
  }

  /**
   * Applies audit filters after checking the date range locally.
   */
  applyLogFilters(): void {
    if (this.logsFrom() && this.logsTo() && this.logsFrom() > this.logsTo()) {
      this.logsError.set('Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
      return;
    }
    this.logsPage.set(1);
    this.loadLogs();
  }

  /**
   * Clears audit filters.
   */
  resetLogFilters(): void {
    this.logsFrom.set('');
    this.logsTo.set('');
    this.logsProduct.set('');
    this.logsAction.set('');
    this.logsUser.set('');
    this.logsPage.set(1);
    this.loadLogs();
  }

  /**
   * Opens the audit payload detail.
   */
  openLog(row: unknown): void {
    this.selectedLog.set(row as AdminAuditRow);
  }

  /**
   * Closes only the audit detail.
   */
  closeLog(): void {
    this.selectedLog.set(null);
  }

  /**
   * Locale money format.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Locale timestamp format.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Category label from the join or the denormalized column.
   */
  categoryName(product: AdminProductRow): string {
    return product.category?.name || product.category_name || '—';
  }

  /**
   * Audit actor label, never a bare UUID when the API enriched the row.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_email || row.actor_id || 'Hệ thống';
  }

  /**
   * Audit action label with the Vietnamese catalog name.
   */
  logAction(row: AdminAuditRow): string {
    return row.action_label || auditActionLabel(row.action || '') || row.action || '—';
  }

  /**
   * Product or variant label for the audit target column.
   */
  logTarget(row: AdminAuditRow): string {
    if (row.target_label) {
      return row.target_label;
    }
    const payload = payloadObject(row.new_value) || payloadObject(row.old_value);
    const sku = String(payload?.['sku'] || '');
    const name = String(payload?.['name'] || '');
    if (sku && name) {
      return `${sku} — ${name}`;
    }
    return sku || name || row.target_id || '—';
  }

  /**
   * Before → after summary for the audit table.
   */
  logChange(row: AdminAuditRow): string {
    if (row.change_summary) {
      return row.change_summary;
    }
    const reason = this.logReason(row);
    if (reason) {
      return reason;
    }
    const created = payloadObject(row.new_value) && !payloadObject(row.old_value);
    return created ? 'Đã tạo sản phẩm' : row.new_value || row.old_value ? 'Đã cập nhật' : '—';
  }

  /**
   * Operator reason carried by a status or stock audit row.
   */
  logReason(row: AdminAuditRow): string {
    if (row.reason) {
      return row.reason;
    }
    const value = payloadObject(row.new_value)?.['reason'] || payloadObject(row.old_value)?.['reason'];
    return typeof value === 'string' ? value : '';
  }

  /**
   * Audit result label.
   */
  logResult(row: AdminAuditRow): string {
    return row.result ? row.result : 'Thành công';
  }

  /**
   * Audit result tone.
   */
  resultTone(row: AdminAuditRow): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
    const key = String(row.result || 'success').toLowerCase();
    if (key === 'success') {
      return 'success';
    }
    if (key.includes('fail') || key.includes('denied')) {
      return 'danger';
    }
    return 'warning';
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
   * Updates the free-text search filter.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the category filter.
   */
  onCategoryChange(event: Event): void {
    this.categoryId.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the status filter.
   */
  onStatusChange(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the server-side sort order.
   */
  onOrderChange(event: Event): void {
    this.order.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Toggles the low-stock filter from the toolbar.
   */
  onLowStockToggle(event: Event): void {
    this.lowStockOnly.set((event.target as HTMLInputElement).checked);
  }

  /**
   * Sets one audit date filter.
   */
  setLogDate(field: 'from' | 'to', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'from') {
      this.logsFrom.set(value);
    } else {
      this.logsTo.set(value);
    }
  }

  /**
   * Sets one free-text audit filter.
   */
  setLogFilter(field: 'product' | 'user' | 'action', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    if (field === 'product') {
      this.logsProduct.set(value);
    } else if (field === 'user') {
      this.logsUser.set(value);
    } else {
      this.logsAction.set(value);
    }
  }

  /**
   * First gallery image of a product, resolved to a browser path.
   */
  thumbnail(product: AdminProductRow): string {
    return primaryImage(product);
  }

  /**
   * Total on-hand stock across the variants of a row.
   */
  stockOf(product: AdminProductRow): number {
    return variantStockTotal(product.variants);
  }

  /**
   * Vietnamese catalog status label.
   */
  statusLabel(status: string | undefined): string {
    return productStatusLabel(status);
  }

  /**
   * Badge tone for a catalog status.
   */
  statusTone(status: string | undefined): AdminTone {
    return productStatusTone(status);
  }

  /**
   * Closes the status modal only.
   */
  closeStatus(): void {
    this.statusOpen.set(false);
    this.statusError.set(null);
  }

  /**
   * Closes the price form only.
   */
  closePrice(): void {
    if (!this.priceSaving()) {
      this.priceOpen.set(false);
      this.priceError.set(null);
    }
  }

  /**
   * Opens the drawer for a product id, rereading its row and variants.
   */
  openDetailById(productId: string): void {
    if (!productId) {
      return;
    }
    this.detailRequest.unsubscribe();
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.variants.set([]);
    this.detailRequest = forkJoin({
      product: this.api.getProduct(productId),
      variants: this.api.listVariants(productId).pipe(catchError(() => of({ rows: [] as AdminProductVariant[] }))),
    }).subscribe({
      next: ({ product, variants }) => {
        this.selected.set({ ...product, variants: adminListRows(variants) });
        this.variants.set(adminListRows(variants));
        this.detailLoading.set(false);
      },
      error: (error: unknown) => {
        this.detailLoading.set(false);
        this.detailError.set(adminErrorMessage(error, 'Không tải được chi tiết sản phẩm.'));
      },
    });
  }

  /** Public reload entry used by the retry buttons in the toolbar and drawers. */
  loadCatalog(): void {
    if (this.tab() !== 'catalog') {
      return;
    }
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const filters = {
      q: this.query(),
      categoryId: this.categoryId(),
      status: this.status(),
      order: this.order(),
      lowStock: this.lowStockOnly() ? 'true' : '',
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    this.listRequest = forkJoin({
      list: this.api.listProducts(filters).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được danh mục sản phẩm.'));
          return of(EMPTY_LIST);
        }),
      ),
      onSale: this.api.listProducts({ status: 'on_sale', limit: '1' }).pipe(catchError(() => of(EMPTY_LIST))),
      hidden: this.api.listProducts({ status: 'hidden', limit: '1' }).pipe(catchError(() => of(EMPTY_LIST))),
      out: this.api.listProducts({ status: 'out_of_stock', limit: '1' }).pipe(catchError(() => of(EMPTY_LIST))),
      // Count only: the stock tab owns the capped low-stock row payload.
      low: this.api.listProducts({ lowStock: 'true', limit: '1' }).pipe(catchError(() => of(EMPTY_LIST))),
    }).subscribe((payload) => {
      this.products.set(adminListRows(payload.list));
      this.total.set(adminListCount(payload.list));
      this.onSale.set(adminListCount(payload.onSale));
      this.hidden.set(adminListCount(payload.hidden));
      this.outOfStock.set(adminListCount(payload.out));
      this.lowStockTotal.set(adminListCount(payload.low));
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /** Public reload entry used by the retry buttons in the toolbar and drawers. */
  loadLowStock(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    this.listRequest = this.api
      .listLowStock()
      .pipe(catchError((error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được cảnh báo tồn kho.'));
        return of(EMPTY_LOW_STOCK);
      }))
      .subscribe((payload) => {
        this.lowStockRows.set(adminListRows(payload));
        this.lowStockTotal.set(adminListCount(payload));
        this.loading.set(false);
        this.hasLoadedOnce.set(true);
      });
  }

  /** Public reload entry used by the retry buttons in the toolbar and drawers. */
  loadLogs(): void {
    this.logsLoading.set(true);
    this.logsError.set(null);
    this.api
      .listProductAuditLogs({
        limit: String(this.pageSize),
        offset: adminOffset(this.logsPage(), this.pageSize),
        from: this.logsFrom(),
        to: this.logsTo(),
        product: this.logsProduct(),
        actionType: this.logsAction(),
        user: this.logsUser(),
      })
      .subscribe({
        next: (payload) => {
          this.logs.set(adminListRows(payload));
          this.logsTotal.set(adminListCount(payload));
          this.logsLoading.set(false);
        },
        error: (error: unknown) => {
          this.logsError.set(adminErrorMessage(error, 'Không tải được nhật ký sản phẩm.'));
          this.logs.set([]);
          this.logsTotal.set(0);
          this.logsLoading.set(false);
        },
      });
  }
}

/** Vietnamese label for a product audit action type. */
function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    CREATE: 'Tạo sản phẩm',
    UPDATE: 'Cập nhật thông tin',
    UPDATE_STATUS: 'Đổi trạng thái',
    UPDATE_STOCK: 'Điều chỉnh tồn kho',
  };
  return labels[String(action).toUpperCase()] || action;
}

/** Primary gallery image, or the local placeholder the storefront uses. */
function primaryImage(product: AdminProductRow): string {
  const url = product.images?.[0];
  if (!url) {
    return PLACEHOLDER_IMAGE;
  }
  return url.replace('/src/assets/', '/assets/');
}

/** Effective selling price of a product line. */
function salePrice(product: AdminProductRow): number {
  return Number(product.sale_price ?? product.base_price ?? 0);
}

/** True when a variant sits at or below its own threshold. */
function isVariantLow(variant: AdminProductVariant): boolean {
  return Number(variant.stock_quantity ?? 0) <= Number(variant.low_stock_threshold ?? 5);
}

/** Narrows an audit payload to an object map. */
function payloadObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Reads a named form control value, trimmed. */
function field(form: HTMLFormElement, name: string): string {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
  return control ? String(control.value).trim() : '';
}
