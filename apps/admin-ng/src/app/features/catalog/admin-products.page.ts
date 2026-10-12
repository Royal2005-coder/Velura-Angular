import { AdminDialogDirective } from '../../shared/admin-dialog.directive';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { forkJoin, of , Subscription } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminCategoryRow,
  AdminComboItemRow,
  AdminImageEnhanceResult,
  AdminImageQualityAnalysis,
  AdminPriceHistoryRow,
  AdminProductFashionSeoResult,
  AdminProductRow,
  AdminProductVariant,
} from '../../core/admin-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';
import { AdminTableSkeleton } from '../../shared/admin-table-skeleton';
import type { ProductImageApproval } from '../../core/product-image-approval.service';


type ProductTab = 'catalog' | 'csv' | 'logs';
type ProductOverlay = 'create' | 'edit' | 'status' | 'stock' | null;

const STATUS_LABEL: Record<string, string> = {
  on_sale: 'Đang bán',
  hidden: 'Tạm ẩn',
  out_of_stock: 'Hết hàng',
  discontinued: 'Ngừng kinh doanh',
};

const STATUS_TONE: Record<string, string> = {
  on_sale: 'active',
  hidden: 'warning',
  out_of_stock: 'danger',
  discontinued: 'neutral',
};

const STATUS_TRANSITIONS: Record<string, string[]> = {
  on_sale: ['hidden', 'out_of_stock', 'discontinued'],
  hidden: ['on_sale', 'discontinued'],
  out_of_stock: ['on_sale', 'hidden', 'discontinued'],
  discontinued: ['hidden'],
};

interface CsvPreviewError {
  row?: number;
  field?: string;
  message?: string;
}

interface CsvPreviewResult {
  rows?: Array<Record<string, unknown>>;
  errors?: CsvPreviewError[];
  totalRows?: number;
  validRows?: number;
}

export interface CreateMatrixVariantRow {
  sku: string;
  color: string;
  colorHex: string;
  size: string;
  stockQuantity: number;
  lowStockThreshold: number;
  salePrice?: number;
}

function guessColorHex(color: string): string {
  const norm = color.trim().toLowerCase();
  if (norm.includes('đen') || norm.includes('black')) return '#1A1A1A';
  if (norm.includes('đỏ') || norm.includes('red') || norm.includes('ruby')) return '#9B111E';
  if (norm.includes('trắng') || norm.includes('white')) return '#FFFFFF';
  if (norm.includes('xanh lam') || norm.includes('xanh dương') || norm.includes('blue')) return '#1E3A8A';
  if (norm.includes('xanh lá') || norm.includes('green')) return '#15803D';
  if (norm.includes('vàng') || norm.includes('yellow')) return '#EAB308';
  if (norm.includes('hồng') || norm.includes('pink')) return '#EC4899';
  if (norm.includes('be') || norm.includes('kem') || norm.includes('beige')) return '#F5F5DC';
  if (norm.includes('nâu') || norm.includes('brown')) return '#78350F';
  if (norm.includes('tím') || norm.includes('purple')) return '#7E22CE';
  if (norm.includes('cam') || norm.includes('orange')) return '#EA580C';
  if (norm.includes('xám') || norm.includes('ghi') || norm.includes('gray')) return '#6B7280';
  return '#4A4039';
}

function normalizeColorCode(color: string): string {
  return (
    color
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase() || 'COLOR'
  );
}

/**
 * Catalog ViewModel: server-paged list, product editor, variants/stock, CSV, audit.
 */
@Component({
  selector: 'app-admin-products-page',
  imports: [AdminDialogDirective, AdminEmptyState, AdminIcon, AdminPagination, AdminTableSkeleton],
  templateUrl: './admin-products.page.html',
})
export class AdminProductsPage {
  private listRequest = new Subscription();
  private readonly adminApi = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly tab = signal<ProductTab>('catalog');
  readonly products = signal<AdminProductRow[]>([]);
  readonly categories = signal<AdminCategoryRow[]>([]);
  readonly variants = signal<AdminProductVariant[]>([]);
  readonly total = signal(0);
  readonly onSale = signal(0);
  readonly hidden = signal(0);
  readonly outOfStock = signal(0);
  readonly lowStockCount = signal(0);
  readonly query = signal('');
  readonly categoryId = signal('');
  readonly status = signal('');
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly loading = signal(true);
  /**
   * Khung xương chỉ hiện ở lần tải đầu. Từ lần sau, bảng cũ vẫn ở nguyên chỗ và
   * chỉ mờ đi — thay cả bảng bằng khung xương ở mỗi lần lọc hay sang trang là bắt
   * người vận hành mất chỗ đang nhìn.
   */
  readonly hasLoadedOnce = signal(false);
  readonly showSkeleton = computed(() => this.loading() && !this.hasLoadedOnce());
  readonly isRefreshing = computed(() => this.loading() && this.hasLoadedOnce());
  readonly loadError = signal<string | null>(null);
  readonly csvMessage = signal('Chưa có file được kiểm tra.');
  readonly csvPreview = signal('');
  readonly csvRows = signal<Array<Record<string, unknown>>>([]);
  readonly csvErrors = signal<CsvPreviewError[]>([]);
  readonly csvValidRows = signal(0);
  readonly csvTotalRows = signal(0);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsLoading = signal(false);
  readonly logsTotal = signal(0);
  readonly logsPage = signal(1);
  readonly logsPageSize = 10;
  readonly selected = signal<AdminProductRow | null>(null);
  readonly overlay = signal<ProductOverlay>(null);
  readonly actionError = signal<string | null>(null);
  readonly nextStatus = signal('');
  readonly priceHistory = signal<AdminPriceHistoryRow[]>([]);
  readonly sourceFile = signal<File | null>(null);
  readonly imageNote = signal<string | null>(null);
  readonly imageIndex = signal(0);
  readonly imageApprovals = signal<ProductImageApproval[]>([]);
  readonly sourceApproved = signal(false);
  readonly bulkSelection = signal<{ productId: string; expectedVersion: number }[]>([]);
  readonly bulkContentOpen = signal(false);
  readonly liveContent = computed(() => {
    const product = this.selected();
    return { title: product?.name || '', description: product?.description || '',
      seoTitle: product?.seo_title || '', metaDescription: product?.seo_description || '', slug: product?.slug || '' };
  });
  readonly canMutate = computed(() => this.session.canMutate('products'));
  readonly canChangePrice = computed(() => this.session.canMutate('pricing'));
  readonly canReadCatalog = computed(() => this.session.canAccessModule('products'));
  readonly priceOnly = computed(() => this.canChangePrice() && !this.canReadCatalog());
  readonly priceTarget = signal<AdminProductRow | null>(null);
  readonly priceSaving = signal(false);
  readonly priceError = signal<string | null>(null);
  readonly canOpenPricing = computed(() => this.session.canOpen('pricing'));

  // Signals cho điều chỉnh giá & chiết khấu trực tiếp trên Sản phẩm
  readonly editBasePrice = signal<number>(0);
  readonly editSalePrice = signal<number | null>(null);
  readonly editPriceReason = signal<string>('Cập nhật chính sách giá niêm yết & khuyến mãi');

  readonly editDiscountPct = computed(() => {
    const base = this.editBasePrice();
    const sale = this.editSalePrice();
    if (!sale || sale >= base || base <= 0) return 0;
    return Math.round(((base - sale) / base) * 100);
  });

  readonly editPriceInvalid = computed(() => {
    const sale = this.editSalePrice();
    return sale != null && sale > this.editBasePrice();
  });

  // Signals cho quản lý thành phần Combo sản phẩm
  readonly comboItems = signal<AdminComboItemRow[]>([]);
  readonly comboLoading = signal(false);
  readonly selectedComponentId = signal<string>('');
  readonly addComboQuantity = signal<number>(1); // Mặc định là 1 sản phẩm, người dùng có thể điều chỉnh

  readonly comboTotalOriginal = computed(() => {
    return this.comboItems().reduce((sum, item) => {
      const p = item.product;
      const price = Number(p?.sale_price || p?.base_price || 0);
      return sum + price * Number(item.quantity || 1);
    }, 0);
  });

  readonly comboSavings = computed(() => {
    const totalOrig = this.comboTotalOriginal();
    const comboPrice = Number(this.editSalePrice() || this.editBasePrice() || 0);
    return Math.max(0, totalOrig - comboPrice);
  });

  readonly comboSavingsPct = computed(() => {
    const totalOrig = this.comboTotalOriginal();
    if (totalOrig <= 0) return 0;
    return Math.round((this.comboSavings() / totalOrig) * 100);
  });

  readonly availableComponentProducts = computed(() => {
    const currentId = this.selected()?.product_id;
    const existingIds = new Set(this.comboItems().map((i) => i.component_product_id));
    return this.products().filter((p) => p.product_id !== currentId && !p.is_combo && !existingIds.has(p.product_id));
  });

  // Signals cho ma trận biến thể khi tạo mới sản phẩm (TC-ADMIN-02)
  readonly createName = signal<string>('');
  readonly createSlug = signal<string>('');
  readonly createMaterial = signal<string>('');
  readonly createMatrixColors = signal<string>('Đen, Đỏ Ruby');
  readonly createMatrixSizes = signal<string>('S, M, L');
  readonly createVariants = signal<CreateMatrixVariantRow[]>([]);
  readonly createBaseSku = signal<string>('');

  readonly totalMatrixStock = computed(() => {
    return this.createVariants().reduce((sum, v) => sum + (Number(v.stockQuantity) || 0), 0);
  });

  // Signals cho thêm biến thể trong drawer Chi tiết sản phẩm
  readonly newVariantColor = signal('');
  readonly newVariantSize = signal('');
  readonly newVariantStock = signal(0);
  readonly newVariantThreshold = signal(5);
  readonly variantSaving = signal(false);
  readonly variantSuccess = signal<string | null>(null);
  readonly variantError = signal<string | null>(null);

  // Signals cho thuộc tính sản phẩm đồng bộ trang Chi tiết sản phẩm User (User PDP) & SEO
  readonly editorBrand = signal<string>('Velura');
  readonly editorCollection = signal<string>('Velura Atelier');
  readonly editorMaterial = signal<string>('Lụa Tơ Tằm');
  readonly editorColorTone = signal<string>('Neutral');
  readonly editorStyleTags = signal<string[]>(['Elegant', 'Smart Casual']);
  readonly editorCustomTag = signal<string>('');
  readonly editorOccasions = signal<string[]>(['Office', 'Casual']);
  readonly editorBodyShapes = signal<string[]>(['Hourglass', 'Rectangle']);
  readonly editorIsFeatured = signal<boolean>(false);
  readonly editorDescription = signal<string>('');
  readonly editorSeoTitle = signal<string>('');
  readonly editorSeoDescription = signal<string>('');
  readonly editorImages = signal<string[]>([]);

  readonly toneOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'Neutral', label: 'Tông da Trung tính (Neutral)' },
    { value: 'Warm', label: 'Tông da Ấm (Warm)' },
    { value: 'Cool', label: 'Tông da Lạnh (Cool)' },
  ];
  readonly presetStyleTags: readonly string[] = [
    'Elegant',
    'Smart Casual',
    'Minimalist',
    'Classic',
    'Modern',
    'Luxury',
    'Feminine',
    'Streetwear',
  ];
  readonly occasionOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'Office', label: 'Công sở' },
    { value: 'Party', label: 'Dự tiệc' },
    { value: 'Casual', label: 'Dạo phố' },
    { value: 'Travel', label: 'Du lịch' },
    { value: 'Date', label: 'Hẹn hò' },
    { value: 'Event', label: 'Sự kiện' },
  ];
  readonly bodyShapeOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'Hourglass', label: 'Dáng đồng hồ cát' },
    { value: 'Rectangle', label: 'Dáng chữ nhật' },
    { value: 'Pear', label: 'Dáng quả lê' },
    { value: 'Apple', label: 'Dáng quả táo' },
    { value: 'Inverted Triangle', label: 'Dáng tam giác ngược' },
  ];

  // Signals cho AI Đánh giá Chất lượng Ảnh & Cải thiện Ảnh Studio (Gemini Vision + K3s U2Net)
  readonly aiImageBusy = signal<boolean>(false);
  readonly aiEnhanceBusy = signal<boolean>(false);
  readonly aiImageError = signal<string | null>(null);
  readonly aiImageAnalysis = signal<AdminImageQualityAnalysis | null>(null);
  readonly aiEnhanceResult = signal<AdminImageEnhanceResult | null>(null);
  readonly aiStudioBg = signal<'studio_white' | 'velura_cream' | 'transparent' | 'keep'>('studio_white');
  readonly aiStudioLighting = signal<boolean>(true);
  readonly aiStudioSharpness = signal<boolean>(true);
  readonly aiStudioUpscale = signal<boolean>(true);
  readonly uploadedImageDataUrl = signal<string>('');
  readonly uploadedImageMime = signal<string>('image/jpeg');

  // Signals cho AI Tối ưu Nội dung & SEO Thời trang (Gemini Fashion SEO Skill)
  readonly aiSeoBusy = signal<boolean>(false);
  readonly aiSeoError = signal<string | null>(null);
  readonly aiSeoSuccess = signal<string | null>(null);
  readonly aiSeoResult = signal<AdminProductFashionSeoResult | null>(null);

  readonly activeImageSlotUrl = computed(() => {
    if (this.uploadedImageDataUrl()) return this.uploadedImageDataUrl();
    const imgs = this.editorImages();
    const idx = this.imageIndex();
    const raw = imgs[idx] || imgs[0] || this.selected()?.images?.[idx] || this.selected()?.images?.[0] || '';
    return raw ? raw.replace('/src/assets/', '/assets/') : '';
  });

  // Signals & computed cho modal Điều chỉnh tồn kho chuẩn ERP
  readonly stockAdjustmentType = signal<'in' | 'out' | 'set'>('in');
  readonly stockAdjustmentQuantity = signal<number>(10);
  readonly selectedVariantId = signal<string>('');
  readonly stockReason = signal<string>('Nhập lô hàng mới từ xưởng may');
  readonly commonStockReasons: readonly string[] = [
    'Nhập lô hàng mới từ xưởng may',
    'Khách hoàn hàng, tái nhập kho',
    'Xuất trả hàng lỗi / bảo hành',
    'Hàng rách, hỏng, tiêu hủy mẫu trưng bày',
    'Cân bằng kiểm kê định kỳ',
  ];

  readonly selectedVariant = computed(() => {
    const id = this.selectedVariantId();
    return this.variants().find((v) => v.variant_id === id) || this.variants()[0] || null;
  });

  readonly currentStock = computed(() => {
    return Number(this.selectedVariant()?.stock_quantity ?? 0);
  });

  readonly projectedStock = computed(() => {
    const current = this.currentStock();
    const qty = Math.max(0, this.stockAdjustmentQuantity());
    const type = this.stockAdjustmentType();
    if (type === 'in') return current + qty;
    if (type === 'out') return Math.max(0, current - qty);
    return qty;
  });

  readonly allowedStatuses = computed(() => {
    const current = this.selected()?.status || 'on_sale';
    const next = STATUS_TRANSITIONS[current] || ['hidden'];
    return next.map((value) => ({
      value,
      label: STATUS_LABEL[value] || value,
      hint:
        value === 'hidden'
          ? 'Ẩn khỏi storefront, giữ dữ liệu đơn cũ'
          : value === 'discontinued'
            ? 'Xóa mềm / ngừng kinh doanh'
            : value === 'out_of_stock'
              ? 'Hết hàng, khách không đặt được'
              : 'Hiện lại trên storefront',
    }));
  });
  readonly csvHasErrors = computed(() => this.csvErrors().length > 0);

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'sản phẩm'));
  readonly logsPageCount = computed(() => Math.max(1, Math.ceil(this.logsTotal() / this.logsPageSize)));
  readonly logsRangeLabel = computed(() =>
    adminRangeLabel(this.logsTotal(), this.logsPage(), this.logsPageSize, 'nhật ký'),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.listRequest.unsubscribe());
    inject(AdminRefreshService).register(() => {
      if (!this.loading() && !this.overlay() && !this.priceTarget()) this.reloadCatalog();
    }, inject(DestroyRef));
    this.reloadCatalog();
    if (!this.priceOnly()) this.adminApi.listCategories().subscribe({
      next: (payload) => this.categories.set(adminListRows(payload)),
    });
  }

  /**
   * Switches catalog / CSV / log tabs.
   */
  setTab(tab: ProductTab): void {
    if (tab !== 'catalog' && !this.canReadCatalog()) return;
    this.tab.set(tab);
    if (tab === 'logs') {
      this.loadLogs();
    }
  }

  /**
   * Moves product-audit pagination through the same list footer as catalog.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logsPageCount(), Math.max(1, page)));
    this.loadLogs();
  }

  /**
   * Applies the catalog filter bar through the list API.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.categoryId.set((form.elements.namedItem('categoryId') as HTMLSelectElement | null)?.value || '');
    this.status.set((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '');
    this.page.set(1);
    this.reloadCatalog();
  }

  /**
   * Clears the original filter bar.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.categoryId.set('');
    this.status.set('');
    this.page.set(1);
    this.reloadCatalog();
  }

  /**
   * Moves catalog pagination and reloads the current filter from the API.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
    this.reloadCatalog();
  }

  /**
   * Formats a catalog price with the storefront locale.
   */
  price(product: AdminProductRow): string {
    const value = product.sale_price || product.base_price || 0;
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
  }

  /**
   * Maps product status to the original Vietnamese badge.
   */
  statusLabel(status: string | undefined): string {
    return STATUS_LABEL[status || ''] || status || '—';
  }

  /**
   * Maps product status to the original badge tone class.
   */
  statusTone(status: string | undefined): string {
    return STATUS_TONE[status || ''] || 'neutral';
  }

  /**
   * Human-readable audit actor (name + email), never raw UUID when enriched.
   */
  logActor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_email || row.actor_id || 'Hệ thống';
  }

  /**
   * Role label under the actor name.
   */
  logActorRole(row: AdminAuditRow): string {
    return row.actor_role_label || row.actor_role || '';
  }

  /**
   * Product/variant label for the audit target column.
   */
  logTarget(row: AdminAuditRow): string {
    if (row.target_label) return row.target_label;
    const payload = this.auditPayload(row.new_value) || this.auditPayload(row.old_value);
    const sku = String(payload?.['sku'] || '');
    const name = String(payload?.['name'] || '');
    if (sku && name) return `${sku} — ${name}`;
    if (sku || name) return sku || name;
    return row.target_id || '—';
  }

  /**
   * Vietnamese action label for product audit rows.
   */
  logAction(row: AdminAuditRow): string {
    return row.action_label || row.action || '—';
  }

  /**
   * Before → after summary for the audit table.
   */
  logChange(row: AdminAuditRow): string {
    if (row.change_summary) return row.change_summary;
    const oldValue = this.auditPayload(row.old_value);
    const newValue = this.auditPayload(row.new_value);
    if (!oldValue && !newValue) return '—';
    if (!oldValue && newValue) {
      const sku = String(newValue['sku'] || '');
      const name = String(newValue['name'] || '');
      return `— → ${[sku, name].filter(Boolean).join(' · ') || 'đã tạo'}`;
    }
    return 'Đã cập nhật';
  }

  /**
   * Outcome column; product mutation audits are written only after success.
   */
  logResult(row: AdminAuditRow): string {
    return row.result || 'Thành công';
  }

  private auditPayload(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  /**
   * Resolves the first catalog image for the entity cell.
   */
  imageUrl(product: AdminProductRow): string {
    const url = product.images?.[0];
    if (!url) {
      return '/assets/images/placeholder.jpg';
    }
    return url.replace('/src/assets/', '/assets/');
  }

  /**
   * Category label from the nested join or denormalized name.
   */
  categoryName(product: AdminProductRow): string {
    return product.category_name || product.category?.name || '—';
  }

  /**
   * Sums variant on-hand stock for the list column.
   */
  stockOf(product: AdminProductRow): number {
    return (product.variants || []).reduce((sum, variant) => sum + Number(variant.stock_quantity || 0), 0);
  }

  /**
   * Formats an ISO timestamp with the original admin locale.
   */
  updatedAt(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Timestamp alias used by the edit overlay history table.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Formats price consistently for both catalog and its integrated price controls.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /** Opens an independent price form without granting catalog editing privileges. */
  openPrice(product: AdminProductRow): void {
    if (!this.canChangePrice() || product.version == null) return;
    this.priceTarget.set(product); this.priceError.set(null);
  }

  /** Dismisses the price form while preserving any in-flight mutation. */
  closePrice(): void {
    if (!this.priceSaving()) this.priceTarget.set(null);
  }

  /** Changes prices with explicit audit reason and the product's current version. */
  submitPrice(event: Event): void {
    event.preventDefault();
    const product = this.priceTarget(), form = event.target as HTMLFormElement;
    if (!product || product.version == null || !this.canChangePrice() || this.priceSaving()) return;
    const base = (form.elements.namedItem('base') as HTMLInputElement | null)?.value.trim() || '';
    const sale = (form.elements.namedItem('sale') as HTMLInputElement | null)?.value.trim() || '';
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement | null)?.value.trim() || '';
    const newBasePrice = Number(base), newSalePrice = sale ? Number(sale) : null;
    if (!base || !Number.isFinite(newBasePrice) || newBasePrice <= 0 || (newSalePrice != null && (!Number.isFinite(newSalePrice) || newSalePrice <= 0 || newSalePrice > newBasePrice)) || reason.length < 10) {
      this.priceError.set('Giá phải lớn hơn 0, giá bán không vượt giá gốc; ghi rõ lý do ít nhất 10 ký tự.'); return;
    }
    this.priceSaving.set(true);
    this.adminApi.changePrice(product.product_id, { newBasePrice, newSalePrice, reason, expectedVersion: product.version }).pipe(finalize(() => this.priceSaving.set(false))).subscribe({
      next: (updated) => { this.priceTarget.set(null); if (this.selected()?.product_id === product.product_id) this.selected.set(updated); this.reloadCatalog(); },
      error: (error: unknown) => this.priceError.set(adminErrorMessage(error)),
    });
  }

  itemTotal(item: AdminComboItemRow): string {
    const unit = Number(item.product?.sale_price || item.product?.base_price || 0);
    return this.money(unit * Number(item.quantity || 1));
  }

  /**
   * Opens create overlay with an empty form.
   */
  openCreate(): void {
    this.resetImageEditor();
    this.selected.set(null);
    this.variants.set([]);
    this.priceHistory.set([]);
    this.overlay.set('create');
    this.actionError.set(null);
    this.createName.set('');
    this.createSlug.set('');
    this.createMaterial.set('Lụa Tơ Tằm');
    this.createBaseSku.set('VL-DAM001');
    this.createMatrixColors.set('Đen, Đỏ Ruby');
    this.createMatrixSizes.set('S, M, L');
    this.variantSaving.set(false);
    this.variantSuccess.set(null);
    this.variantError.set(null);
    this.editorBrand.set('Velura');
    this.editorCollection.set('Velura Atelier');
    this.editorMaterial.set('Lụa Tơ Tằm');
    this.editorColorTone.set('Neutral');
    this.editorStyleTags.set(['Elegant', 'Smart Casual']);
    this.editorCustomTag.set('');
    this.editorOccasions.set(['Office', 'Casual']);
    this.editorBodyShapes.set(['Hourglass', 'Rectangle']);
    this.editorIsFeatured.set(false);
    this.editorDescription.set('');
    this.editorSeoTitle.set('');
    this.editorSeoDescription.set('');
    this.editorImages.set([]);
    this.resetAiSeoState();
    this.generateSkuMatrix('VL-DAM001');
  }

  onNameInput(event: Event): void {
    if (this.overlay() === 'create') {
      const val = (event.target as HTMLInputElement).value;
      const prevName = this.createName();
      this.createName.set(val);
      if (!this.createSlug() || this.createSlug() === this.slugFromName(prevName)) {
        this.createSlug.set(this.slugFromName(val));
      }
    }
  }

  onSkuInput(event: Event): void {
    if (this.overlay() === 'create') {
      const sku = (event.target as HTMLInputElement).value.trim().toUpperCase();
      this.createBaseSku.set(sku);
      if (this.createVariants().length > 0 && sku) {
        this.createVariants.update((list) =>
          list.map((row) => {
            const colorCode = normalizeColorCode(row.color);
            return {
              ...row,
              sku: `${sku}-${colorCode}-${row.size}`,
            };
          })
        );
      }
    }
  }

  generateSkuMatrix(baseSkuInput?: string): void {
    const rawColors = this.createMatrixColors()
      .split(/[,;\n]/)
      .map((c) => c.trim())
      .filter(Boolean);
    const rawSizes = this.createMatrixSizes()
      .split(/[,;\n]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!rawColors.length || !rawSizes.length) {
      this.actionError.set('Vui lòng nhập ít nhất 1 màu sắc và 1 kích thước để tạo ma trận.');
      return;
    }

    const baseSku = (baseSkuInput || this.createBaseSku() || 'VL-DAM001').trim().toUpperCase();
    const rows: CreateMatrixVariantRow[] = [];

    for (const color of rawColors) {
      const colorCode = normalizeColorCode(color);
      const colorHex = guessColorHex(color);
      for (const size of rawSizes) {
        rows.push({
          sku: `${baseSku}-${colorCode}-${size}`,
          color,
          colorHex,
          size,
          stockQuantity: 10,
          lowStockThreshold: 5,
        });
      }
    }

    this.createVariants.set(rows);
    this.actionError.set(null);
  }

  updateMatrixVariantStock(index: number, stock: number): void {
    this.createVariants.update((list) => {
      const updated = [...list];
      if (updated[index]) {
        updated[index] = { ...updated[index], stockQuantity: Math.max(0, isNaN(stock) ? 0 : stock) };
      }
      return updated;
    });
  }

  updateMatrixVariantPrice(index: number, price: number): void {
    this.createVariants.update((list) => {
      const updated = [...list];
      if (updated[index]) {
        updated[index] = { ...updated[index], salePrice: Math.max(0, isNaN(price) ? 0 : price) };
      }
      return updated;
    });
  }

  updateMatrixVariantThreshold(index: number, threshold: number): void {
    this.createVariants.update((list) => {
      const updated = [...list];
      if (updated[index]) {
        updated[index] = { ...updated[index], lowStockThreshold: Math.max(0, isNaN(threshold) ? 0 : threshold) };
      }
      return updated;
    });
  }

  removeMatrixVariant(index: number): void {
    this.createVariants.update((list) => list.filter((_, i) => i !== index));
  }

  clearMatrixVariants(): void {
    this.createVariants.set([]);
  }

  /**
   * Loads product detail + variants into the editor drawer.
   */
  openEdit(product: AdminProductRow): void {
    this.resetImageEditor();
    this.resetAiSeoState();
    this.selected.set(null);
    this.actionError.set(null);
    this.overlay.set('edit');
    this.priceHistory.set([]);
    this.comboItems.set([]);
    this.selectedComponentId.set('');
    this.addComboQuantity.set(1);
    this.editBasePrice.set(Number(product.base_price || 0));
    this.editSalePrice.set(product.sale_price != null ? Number(product.sale_price) : null);
    this.editPriceReason.set('Cập nhật chính sách giá niêm yết & khuyến mãi');
    this.newVariantColor.set('');
    this.newVariantSize.set('');
    this.newVariantStock.set(0);
    this.newVariantThreshold.set(5);
    this.variantSaving.set(false);
    this.variantSuccess.set(null);
    this.variantError.set(null);
    this.syncEditorSignalsFromProduct(product);

    this.adminApi.getProduct(product.product_id).subscribe({
      next: (row) => {
        this.selected.set(row);
        this.variants.set(row.variants || []);
        this.editBasePrice.set(Number(row.base_price || 0));
        this.editSalePrice.set(row.sale_price != null ? Number(row.sale_price) : null);
        this.syncEditorSignalsFromProduct(row);
        if (row.is_combo) {
          this.loadComboItems(row.product_id);
        }
        if (row.images?.length) {
          this.analyzeActiveImage();
        }
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
    this.adminApi.listVariants(product.product_id).subscribe({
      next: (payload) => this.variants.set(adminListRows(payload)),
    });
    this.adminApi.listPriceHistory({ productId: product.product_id, limit: '10' }).subscribe({
      next: (payload) => this.priceHistory.set(adminListRows(payload)),
      error: () => this.priceHistory.set([]),
    });
    if (product.is_combo) {
      this.loadComboItems(product.product_id);
    }
  }

  private syncEditorSignalsFromProduct(row: AdminProductRow): void {
    this.editorBrand.set(row.brand || 'Velura');
    this.editorCollection.set(row.collection || 'Velura Atelier');
    const desc = row.description || '';
    const matMatch = desc.match(/Chất liệu:\s*([^\n.]+)/i);
    this.editorMaterial.set(matMatch?.[1]?.trim() || this.createMaterial() || 'Lụa & Sợi tự nhiên cao cấp');
    this.editorColorTone.set(row.color_tone || 'Neutral');
    this.editorStyleTags.set(row.style_tags?.length ? [...row.style_tags] : ['Elegant', 'Smart Casual']);
    this.editorOccasions.set(row.occasions?.length ? [...row.occasions] : ['Office', 'Casual']);
    this.editorBodyShapes.set(
      row.suitable_body_shapes?.length ? [...row.suitable_body_shapes] : ['Hourglass', 'Rectangle'],
    );
    this.editorIsFeatured.set(Boolean(row.is_featured));
    this.editorDescription.set(desc);
    this.editorSeoTitle.set(row.seo_title || '');
    this.editorSeoDescription.set(row.seo_description || '');
    this.editorImages.set([...(row.images || [])]);
  }

  loadComboItems(productId: string): void {
    this.comboLoading.set(true);
    this.adminApi.listComboItems(productId).subscribe({
      next: (items) => {
        this.comboItems.set(items);
        this.comboLoading.set(false);
      },
      error: () => {
        this.comboItems.set([]);
        this.comboLoading.set(false);
      },
    });
  }

  submitAddComboItem(): void {
    const product = this.selected();
    const componentId = this.selectedComponentId();
    const qty = Math.max(1, Number(this.addComboQuantity() || 1));
    if (!product || !componentId) return;

    this.adminApi
      .addComboItem(product.product_id, {
        componentProductId: componentId,
        quantity: qty,
      })
      .subscribe({
        next: () => {
          this.selectedComponentId.set('');
          this.addComboQuantity.set(1);
          this.loadComboItems(product.product_id);
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
  }

  changeComboItemQuantity(item: AdminComboItemRow, delta: number): void {
    const product = this.selected();
    if (!product) return;
    const newQty = Math.max(1, item.quantity + delta);
    if (newQty === item.quantity) return;

    this.adminApi.updateComboItem(product.product_id, item.combo_item_id, { quantity: newQty }).subscribe({
      next: () => this.loadComboItems(product.product_id),
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  removeComboItem(item: AdminComboItemRow): void {
    const product = this.selected();
    if (!product) return;
    this.adminApi.removeComboItem(product.product_id, item.combo_item_id).subscribe({
      next: () => this.loadComboItems(product.product_id),
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Opens the original product status modal.
   */
  openStatus(product: AdminProductRow): void {
    this.selected.set(product);
    const allowed = STATUS_TRANSITIONS[product.status || ''] || ['hidden'];
    this.nextStatus.set(allowed.includes('hidden') ? 'hidden' : allowed[0] || 'hidden');
    this.overlay.set('status');
    this.actionError.set(null);
  }

  /**
   * Opens stock adjustment for the first or selected variant with ERP controls.
   */
  openStock(product: AdminProductRow): void {
    this.selected.set(product);
    this.overlay.set('stock');
    this.actionError.set(null);
    this.stockAdjustmentType.set('in');
    this.stockAdjustmentQuantity.set(10);
    this.stockReason.set('Nhập lô hàng mới từ xưởng may');

    // Nạp ngay biến thể sẵn có của sản phẩm để dropdown không bị rỗng
    const initialVariants = product.variants || [];
    this.variants.set(initialVariants);
    if (initialVariants.length > 0) {
      this.selectedVariantId.set(initialVariants[0].variant_id);
    } else {
      this.selectedVariantId.set('');
    }

    this.adminApi.listVariants(product.product_id).subscribe({
      next: (payload) => {
        const rows = adminListRows(payload);
        if (rows.length > 0) {
          this.variants.set(rows);
          if (!this.selectedVariantId() || !rows.find((r) => r.variant_id === this.selectedVariantId())) {
            this.selectedVariantId.set(rows[0].variant_id);
          }
        }
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Closes the product overlays.
   */
  closeOverlays(): void {
    this.resetImageEditor();
    this.selected.set(null);
    this.overlay.set(null);
    this.actionError.set(null);
  }

  /**
   * Creates or patches a product from the editor form.
   */
  submitEditor(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      this.actionError.set('Role hiện tại không được ghi catalog.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const name = (form.elements.namedItem('name') as HTMLInputElement | null)?.value.trim() || '';
    const sku = (form.elements.namedItem('sku') as HTMLInputElement | null)?.value.trim().toUpperCase() || '';
    const slug =
      (form.elements.namedItem('slug') as HTMLInputElement | null)?.value.trim().toLowerCase() ||
      this.slugFromName(name);
    const categoryId = (form.elements.namedItem('categoryId') as HTMLSelectElement | null)?.value || '';
    const collection =
      (form.elements.namedItem('collection') as HTMLInputElement | null)?.value.trim() ??
      this.editorCollection().trim();
    const brand =
      (form.elements.namedItem('brand') as HTMLInputElement | null)?.value.trim() ||
      this.editorBrand().trim() ||
      'Velura';
    const description =
      (form.elements.namedItem('description') as HTMLTextAreaElement | null)?.value.trim() ??
      this.editorDescription().trim();
    const seoTitle =
      (form.elements.namedItem('seoTitle') as HTMLInputElement | null)?.value.trim() ??
      this.editorSeoTitle().trim();
    const seoDescription =
      (form.elements.namedItem('seoDescription') as HTMLTextAreaElement | null)?.value.trim() ??
      this.editorSeoDescription().trim();
    const imagesEl = form.elements.namedItem('images') as HTMLTextAreaElement | null;
    const imagesRaw = imagesEl ? imagesEl.value.trim() : this.editorImages().join('\n');
    const images = imagesRaw
      ? imagesRaw
          .split(/\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const previousImages = this.selected()?.images || [];
    const approvals = this.imageApprovals();
    if (this.sourceFile() && !this.sourceApproved()) {
      this.actionError.set('Phê duyệt ảnh mới hoặc mở lại sản phẩm để bỏ ảnh đang chọn.');
      return;
    }
    if (
      images.some(
        (url) =>
          !previousImages.includes(url) &&
          !approvals.some((approval) => approval.url === url && Date.parse(approval.expiresAt) > Date.now()),
      )
    ) {
      this.actionError.set('Ảnh mới cần kiểm tra và phê duyệt trong quy trình ảnh; không dán URL chưa duyệt.');
      return;
    }
    if (!name || name.length < 2) {
      this.actionError.set('Tên sản phẩm phải từ 2 ký tự.');
      return;
    }
    if (!categoryId) {
      this.actionError.set('Chọn danh mục trước khi lưu.');
      return;
    }
    const overlay = this.overlay();
    if (overlay === 'create') {
      if (!/^[A-Z]{2,6}-[A-Z0-9]{2,20}(-[A-Z0-9]{1,10})*$/.test(sku)) {
        this.actionError.set('SKU phải dạng VL-AO001 hoặc VLR-DV006.');
        return;
      }
      const basePrice = Number((form.elements.namedItem('basePrice') as HTMLInputElement | null)?.value || 0);
      const salePrice = Number(
        (form.elements.namedItem('salePrice') as HTMLInputElement | null)?.value || basePrice,
      );
      const status = (form.elements.namedItem('createStatus') as HTMLSelectElement | null)?.value || 'on_sale';
      const initialStockInput = Number(
        (form.elements.namedItem('initialStock') as HTMLInputElement | null)?.value || 0,
      );
      const isCombo = (form.elements.namedItem('isCombo') as HTMLInputElement | null)?.checked ?? false;
      const material = this.editorMaterial().trim() || this.createMaterial().trim();

      if (this.createVariants().length === 0 && this.createMatrixColors().trim() && this.createMatrixSizes().trim()) {
        this.generateSkuMatrix(sku);
      }
      const matrixVariants = this.createVariants();
      const initialStock = matrixVariants.length > 0 ? this.totalMatrixStock() : initialStockInput;

      this.adminApi
        .createProduct({
          sku,
          name,
          slug,
          categoryId,
          brand,
          basePrice,
          salePrice,
          status,
          collection,
          description,
          seoTitle: seoTitle || undefined,
          seoDescription: seoDescription || undefined,
          colorTone: this.editorColorTone() || 'Neutral',
          styleTags: this.editorStyleTags(),
          occasions: this.editorOccasions(),
          suitableBodyShapes: this.editorBodyShapes(),
          isFeatured: this.editorIsFeatured(),
          images,
          material: material || undefined,
          variants: matrixVariants.length > 0 ? matrixVariants : undefined,
          initialStock,
          isCombo,
          expectedVersion: 0,
        })
        .subscribe({
          next: () => {
            this.closeOverlays();
            this.reloadCatalog();
          },
          error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
        });
      return;
    }
    const product = this.selected();
    if (!product || product.version == null) {
      this.actionError.set('Thiếu phiên bản sản phẩm để cập nhật.');
      return;
    }

    if (this.editPriceInvalid()) {
      this.actionError.set('Giá bán khuyến mãi không được lớn hơn giá gốc.');
      return;
    }

    const currentBase = Number(product.base_price || 0);
    const currentSale = product.sale_price != null ? Number(product.sale_price) : null;
    const newBase = this.editBasePrice();
    const newSale = this.editSalePrice();
    const priceChanged = newBase !== currentBase || newSale !== currentSale;

    if (priceChanged && !this.canChangePrice()) {
      this.actionError.set('Bạn không có quyền điều chỉnh giá. Liên hệ người quản lý giá.');
      return;
    }
    if (priceChanged && approvals.length) {
      this.actionError.set(
        'Lưu điều chỉnh giá riêng trước, rồi mở lại sản phẩm và phê duyệt ảnh theo phiên bản mới.',
      );
      return;
    }
    const saveDetails = (expectedVersion: number) => {
      this.adminApi
        .updateProduct(product.product_id, {
          name,
          categoryId,
          brand,
          collection,
          description,
          seoTitle: seoTitle || null,
          seoDescription: seoDescription || null,
          colorTone: this.editorColorTone() || 'Neutral',
          styleTags: this.editorStyleTags(),
          occasions: this.editorOccasions(),
          suitableBodyShapes: this.editorBodyShapes(),
          isFeatured: this.editorIsFeatured(),
          images,
          expectedVersion,
        })
        .subscribe({
          next: () => {
            this.closeOverlays();
            this.reloadCatalog();
          },
          error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
        });
    };

    if (priceChanged) {
      this.adminApi
        .changePrice(product.product_id, {
          newBasePrice: newBase,
          newSalePrice: newSale,
          reason: this.editPriceReason() || 'Cập nhật giá từ quản lý sản phẩm',
          expectedVersion: product.version,
        })
        .subscribe({
          next: (updated) => {
            if (updated.version == null) {
              this.actionError.set(
                'Giá đã được lưu. Phản hồi thiếu phiên bản mới; mở lại sản phẩm trước khi lưu thông tin.',
              );
              return;
            }
            this.selected.set(updated);
            saveDetails(updated.version);
          },
          error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
        });
    } else {
      saveDetails(product.version);
    }
  }

  /**
   * Adds a variant from the editor variant section.
   */
  submitNewVariant(): void {
    const product = this.selected();
    if (!product) {
      return;
    }
    const color = this.newVariantColor().trim();
    const size = this.newVariantSize().trim();
    if (!color || !size) {
      this.variantError.set('Vui lòng nhập màu sắc và kích thước cho biến thể mới.');
      return;
    }
    this.variantSaving.set(true);
    this.variantError.set(null);
    this.variantSuccess.set(null);

    this.adminApi
      .createVariant(product.product_id, {
        color,
        colorHex: guessColorHex(color),
        size,
        stockQuantity: this.newVariantStock(),
        lowStockThreshold: this.newVariantThreshold(),
      })
      .pipe(
        finalize(() => this.variantSaving.set(false))
      )
      .subscribe({
        next: () => {
          this.newVariantColor.set('');
          this.newVariantSize.set('');
          this.newVariantStock.set(0);
          this.newVariantThreshold.set(5);
          this.variantSuccess.set(`Đã thêm thành công biến thể: ${color} - Size ${size}`);

          // Cập nhật ngay danh sách biến thể trong drawer mà không đóng / flicker
          this.adminApi.listVariants(product.product_id).subscribe({
            next: (payload) => {
              const rows = adminListRows(payload);
              this.variants.set(rows);
              this.selected.update((curr) => (curr ? { ...curr, variants: rows } : null));
            },
          });
          // Refresh catalog table in background
          this.reloadCatalog();

          setTimeout(() => {
            this.variantSuccess.set(null);
          }, 3500);
        },
        error: (error: unknown) => {
          const msg = adminErrorMessage(error);
          this.variantError.set(msg);
        },
      });
  }

  /**
   * Backwards compatible variant form submit.
   */
  submitVariant(event: Event): void {
    event.preventDefault();
    this.submitNewVariant();
  }

  setStockAdjustmentType(type: 'in' | 'out' | 'set'): void {
    this.stockAdjustmentType.set(type);
  }

  selectStockReason(reason: string): void {
    this.stockReason.set(reason);
  }

  onVariantSelect(event: Event): void {
    this.selectedVariantId.set((event.target as HTMLSelectElement).value);
  }

  onStockQuantityChange(event: Event): void {
    const val = Number((event.target as HTMLInputElement).value || 0);
    this.stockAdjustmentQuantity.set(Math.max(0, val));
  }

  onStockReasonChange(event: Event): void {
    this.stockReason.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Applies an ERP-grade stock adjustment on the selected variant.
   */
  submitStock(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    const variant = this.selectedVariant();
    if (!product || !variant) {
      this.actionError.set('Vui lòng chọn biến thể cần điều chỉnh.');
      return;
    }

    const current = Number(variant.stock_quantity ?? 0);
    const qty = this.stockAdjustmentQuantity();
    const type = this.stockAdjustmentType();
    let delta = 0;
    if (type === 'in') {
      delta = qty;
    } else if (type === 'out') {
      delta = -qty;
    } else {
      delta = qty - current;
    }

    if (delta === 0) {
      this.actionError.set('Số lượng điều chỉnh không làm thay đổi tồn kho.');
      return;
    }

    const reason = this.stockReason().trim();
    if (!reason || reason.length < 5) {
      this.actionError.set('Vui lòng nhập lý do điều chỉnh từ 5 ký tự.');
      return;
    }

    this.adminApi
      .updateStock(product.product_id, {
        variantId: variant.variant_id,
        delta,
        reason,
        expectedVersion: variant.version ?? 1,
      })
      .subscribe({
        next: () => {
          this.closeOverlays();
          this.reloadCatalog();
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
  }

  /**
   * Changes product status through the original catalog API.
   */
  submitStatus(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    if (!product || product.version == null) {
      this.actionError.set('Thiếu phiên bản sản phẩm để đổi trạng thái.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const status = (form.elements.namedItem('status') as HTMLSelectElement | HTMLInputElement).value;
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement).value.trim();
    if (!status) {
      this.actionError.set('Chọn trạng thái mới, gồm Tạm ẩn hoặc Ngừng kinh doanh.');
      return;
    }
    if (reason.length < 10) {
      this.actionError.set('Lý do đổi trạng thái tối thiểu 10 ký tự.');
      return;
    }
    this.adminApi.changeProductStatus(product.product_id, { status, reason, expectedVersion: product.version }).subscribe({
      next: () => {
        this.closeOverlays();
        this.reloadCatalog();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Selects a status option in the hide / soft-delete modal.
   */
  chooseStatus(status: string): void {
    this.nextStatus.set(status);
  }

  /**
   * Downloads the Velura CSV template with a real category UUID when available.
   */
  downloadCsvTemplate(): void {
    const categoryId = this.categories()[0]?.category_id || '00000000-0000-4000-8000-000000000001';
    const csv = [
      'sku,name,base_price,category_id,sale_price,status,description,image_url',
      `VLR-UAT001,Ao linen mau kem,450000,${categoryId},420000,on_sale,Mau CSV hop le,`,
      `bad-sku,Ten thieu gia,not-a-price,${categoryId},,on_sale,Dong loi de test preview,`,
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'velura-products-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Replace only the selected slot with the server-attested URL, without downloading or uploading its bytes. */
  acceptAiImage(approval: ProductImageApproval, images: HTMLTextAreaElement): void {
    if (!this.canMutate() || Date.parse(approval.expiresAt) <= Date.now()) return;
    if (!this.sourceFile() && !this.uploadedImageDataUrl() && !this.aiEnhanceResult()) return;
    const current = images.value.split(/\n|,/).map((value) => value.trim()).filter(Boolean);
    const index = Math.min(this.imageIndex(), current.length);
    current.splice(index, index < current.length ? 1 : 0, approval.url);
    images.value = current.join('\n');
    this.editorImages.set([...current]);
    this.imageApprovals.update((rows) => [...rows.filter((row) => current.includes(row.url)), approval]);
    this.sourceApproved.set(true);
    this.imageNote.set('Ảnh đã duyệt được chọn trong bản chỉnh sửa. Bấm Lưu để công bố.');
  }

  /** Select replacement bytes and immediately trigger AI Studio quality analysis. */
  uploadImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canMutate()) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      this.aiImageError.set('Vui lòng chọn ảnh định dạng JPG, PNG hoặc WebP dưới 8 MB.');
      return;
    }
    this.sourceFile.set(file);
    this.sourceApproved.set(false);
    this.uploadedImageMime.set(file.type || 'image/jpeg');
    this.aiImageError.set(null);
    this.aiEnhanceResult.set(null);
    this.imageNote.set('AI đang phân tích chất lượng hình ảnh vừa tải lên...');

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      this.uploadedImageDataUrl.set(dataUrl);
      this.analyzeActiveImage(dataUrl, file.type);
    };
    reader.readAsDataURL(file);
  }

  /** Choose the catalog slot deliberately before selecting replacement bytes. */
  chooseImageIndex(event: Event): void {
    const idx = Number((event.target as HTMLSelectElement).value);
    this.selectGalleryImageSlot(idx);
  }

  selectGalleryImageSlot(index: number): void {
    this.imageIndex.set(index);
    this.sourceFile.set(null);
    this.sourceApproved.set(false);
    this.uploadedImageDataUrl.set('');
    this.aiEnhanceResult.set(null);
    this.aiImageError.set(null);
    const imgs = this.editorImages();
    if (imgs[index]) {
      this.analyzeActiveImage();
    } else {
      this.aiImageAnalysis.set(null);
    }
  }

  removeGalleryImageSlot(index: number, imagesBox?: HTMLTextAreaElement): void {
    if (!this.canMutate()) return;
    const current = [...this.editorImages()];
    if (index < 0 || index >= current.length) return;
    current.splice(index, 1);
    this.editorImages.set(current);
    if (imagesBox) {
      imagesBox.value = current.join('\n');
    }
    if (this.imageIndex() >= current.length) {
      this.imageIndex.set(Math.max(0, current.length - 1));
    }
  }

  /** Runs AI Studio quality assessment on either the uploaded image or the active product gallery image. */
  analyzeActiveImage(overrideDataUrl?: string, overrideMime?: string): void {
    const dataUrl = overrideDataUrl ?? this.uploadedImageDataUrl();
    const mime = overrideMime ?? this.uploadedImageMime();
    const existingUrl = !dataUrl ? this.activeImageSlotUrl() : '';
    if (!dataUrl && !existingUrl) {
      this.aiImageError.set('Chưa có hình ảnh để phân tích. Vui lòng tải ảnh sản phẩm lên.');
      return;
    }
    this.aiImageBusy.set(true);
    this.aiImageError.set(null);
    const prodName = this.overlay() === 'create' ? this.createName() : this.selected()?.name || '';
    this.adminApi
      .analyzeProductImage({
        ...(dataUrl ? { imageBase64: dataUrl, mimeType: mime } : { imageUrl: existingUrl }),
        productName: prodName,
      })
      .pipe(finalize(() => this.aiImageBusy.set(false)))
      .subscribe({
        next: (res) => {
          if (res && typeof res.overallScore === 'number') {
            this.aiImageAnalysis.set(res);
            if (dataUrl && res.uploadedUrl && res.passed) {
              this.imageNote.set('Ảnh đạt chuẩn Studio! Bạn có thể dùng ngay ảnh gốc hoặc bấm Cải thiện bằng AI.');
            } else if (res.needsEnhancement) {
              this.imageNote.set('AI phát hiện điểm cần tối ưu về ánh sáng/nền ảnh. Bấm nút Cải thiện chất lượng ảnh bằng AI bên dưới.');
            }
          }
        },
        error: (err: unknown) => {
          this.aiImageError.set(adminErrorMessage(err, 'Không phân tích được chất lượng ảnh lúc này.'));
        },
      });
  }

  /** Runs K3s AI Worker U2Net + Sharp Studio Enhancement on the uploaded or active existing product image. */
  generateAiEnhancedImage(): void {
    if (!this.canMutate() || this.aiEnhanceBusy()) return;
    const dataUrl = this.uploadedImageDataUrl();
    const mime = this.uploadedImageMime();
    const existingUrl = !dataUrl ? this.activeImageSlotUrl() : '';
    if (!dataUrl && !existingUrl) {
      this.aiImageError.set('Vui lòng chọn hoặc tải ảnh sản phẩm lên trước khi cải thiện bằng AI.');
      return;
    }
    this.aiEnhanceBusy.set(true);
    this.aiImageError.set(null);
    this.adminApi
      .enhanceProductImage({
        ...(dataUrl ? { imageBase64: dataUrl, mimeType: mime } : { imageUrl: existingUrl }),
        options: {
          background: this.aiStudioBg(),
          lighting: this.aiStudioLighting(),
          sharpness: this.aiStudioSharpness(),
          upscale: this.aiStudioUpscale(),
        },
      })
      .pipe(finalize(() => this.aiEnhanceBusy.set(false)))
      .subscribe({
        next: (result) => {
          if (result && result.enhancedUrl) {
            this.aiEnhanceResult.set(result);
            this.aiImageAnalysis.set(result.afterAnalysis);
            this.imageNote.set('AI đã tạo phiên bản ảnh Studio chất lượng cao! Bấm "Áp dụng ảnh AI Studio" để đưa vào sản phẩm.');
          }
        },
        error: (err: unknown) => {
          this.aiImageError.set(adminErrorMessage(err, 'Chưa thể cải thiện ảnh bằng AI lúc này.'));
        },
      });
  }

  /** Applies the AI-enhanced studio image directly into the active gallery slot and marks it approved. */
  applyAiEnhancedImage(imagesBox?: HTMLTextAreaElement): void {
    const enhanced = this.aiEnhanceResult();
    if (!enhanced?.enhancedUrl || !this.canMutate()) return;
    this.applyApprovedImageUrl(enhanced.enhancedUrl, enhanced.modelUsed || 'velura-studio-v2', imagesBox);
    this.imageNote.set('✓ Đã áp dụng ảnh AI Studio vào danh sách ảnh sản phẩm. Bấm Lưu để xuất bản.');
  }

  /** Applies the newly uploaded original image directly into the active gallery slot. */
  applyOriginalUploadedImage(imagesBox?: HTMLTextAreaElement): void {
    const uploadedUrl = this.aiImageAnalysis()?.uploadedUrl || this.uploadedImageDataUrl();
    if (!uploadedUrl || !this.canMutate()) return;
    this.applyApprovedImageUrl(uploadedUrl, 'original-verified-v1', imagesBox);
    this.imageNote.set('✓ Đã áp dụng ảnh tải lên vào danh sách ảnh sản phẩm. Bấm Lưu để xuất bản.');
  }

  private applyApprovedImageUrl(url: string, processingVersion: string, imagesBox?: HTMLTextAreaElement): void {
    const current = [...this.editorImages()];
    const index = Math.min(this.imageIndex(), current.length);
    current.splice(index, index < current.length ? 1 : 0, url);
    this.editorImages.set(current);
    if (imagesBox) {
      imagesBox.value = current.join('\n');
    }
    const approval: ProductImageApproval = {
      approvalId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `appr-${Date.now()}`,
      url,
      sourceRevision: 'ai-studio-verified',
      processingVersion,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    this.imageApprovals.update((rows) => [...rows.filter((r) => current.includes(r.url)), approval]);
    this.sourceFile.set(null);
    this.sourceApproved.set(true);
    this.uploadedImageDataUrl.set('');
    this.aiEnhanceResult.set(null);
  }

  toggleStyleTag(tag: string): void {
    if (!this.canMutate()) return;
    this.editorStyleTags.update((list) => (list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag]));
  }

  addCustomStyleTag(): void {
    if (!this.canMutate()) return;
    const raw = this.editorCustomTag().trim();
    if (!raw) return;
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.editorStyleTags.update((list) => [...new Set([...list, ...parts])].slice(0, 20));
    this.editorCustomTag.set('');
  }

  removeStyleTag(tag: string): void {
    if (!this.canMutate()) return;
    this.editorStyleTags.update((list) => list.filter((t) => t !== tag));
  }

  toggleOccasion(value: string): void {
    if (!this.canMutate()) return;
    this.editorOccasions.update((list) =>
      list.includes(value) ? list.filter((o) => o !== value) : [...list, value],
    );
  }

  toggleBodyShape(value: string): void {
    if (!this.canMutate()) return;
    this.editorBodyShapes.update((list) =>
      list.includes(value) ? list.filter((b) => b !== value) : [...list, value],
    );
  }

  /** Calls Gemini Fashion SEO skill to optimize description, SEO title/meta, and User PDP attributes. */
  optimizeSeoWithAi(formEl?: HTMLFormElement): void {
    if (!this.canMutate() || this.aiSeoBusy()) return;
    const nameInput = formEl ? (formEl.elements.namedItem('name') as HTMLInputElement | null)?.value.trim() : '';
    const skuInput = formEl ? (formEl.elements.namedItem('sku') as HTMLInputElement | null)?.value.trim() : '';
    const catSelect = formEl ? (formEl.elements.namedItem('categoryId') as HTMLSelectElement | null)?.value : '';
    const name = nameInput || (this.overlay() === 'create' ? this.createName() : this.selected()?.name || '');
    const sku = skuInput || (this.overlay() === 'create' ? this.createBaseSku() : this.selected()?.sku || '');
    if (!name || name.length < 2) {
      this.aiSeoError.set('Vui lòng nhập Tên sản phẩm trước khi bấm Tối ưu SEO bằng AI.');
      return;
    }
    const categoryObj = this.categories().find((c) => c.category_id === (catSelect || this.selected()?.category_id));
    const categoryName = categoryObj?.name || this.selected()?.category?.name || 'Thời trang thiết kế';
    const colors =
      this.overlay() === 'create'
        ? this.createMatrixColors()
        : [...new Set(this.variants().map((v) => v.color).filter(Boolean))].join(', ');
    const sizes =
      this.overlay() === 'create'
        ? this.createMatrixSizes()
        : [...new Set(this.variants().map((v) => v.size).filter(Boolean))].join(', ');

    this.aiSeoBusy.set(true);
    this.aiSeoError.set(null);
    this.aiSeoSuccess.set(null);

    this.adminApi
      .optimizeProductSeo({
        name,
        sku,
        categoryName,
        brand: this.editorBrand(),
        collection: this.editorCollection(),
        material: this.editorMaterial(),
        description: this.editorDescription(),
        colors,
        sizes,
      })
      .pipe(finalize(() => this.aiSeoBusy.set(false)))
      .subscribe({
        next: (res) => {
          if (!res || !res.description) {
            this.aiSeoError.set('Chưa nhận được dữ liệu SEO từ AI. Vui lòng thử lại.');
            return;
          }
          this.aiSeoResult.set(res);
          this.editorDescription.set(res.description);
          this.editorSeoTitle.set(res.seoTitle || '');
          this.editorSeoDescription.set(res.seoDescription || '');
          if (res.collection) this.editorCollection.set(res.collection);
          if (res.material) {
            this.editorMaterial.set(res.material);
            this.createMaterial.set(res.material);
          }
          if (res.colorTone) this.editorColorTone.set(res.colorTone);
          if (res.styleTags?.length) this.editorStyleTags.set(res.styleTags);
          if (res.occasions?.length) this.editorOccasions.set(res.occasions);
          if (res.suitableBodyShapes?.length) this.editorBodyShapes.set(res.suitableBodyShapes);
          this.aiSeoSuccess.set(
            `Đã tối ưu Mô tả, Chuẩn SEO (${res.seoScore}/100 điểm · ${res.modelUsed}) và đồng bộ thuộc tính hiển thị trang User PDP!`,
          );
        },
        error: (err: unknown) => {
          this.aiSeoError.set(adminErrorMessage(err, 'Không thể tạo nội dung SEO lúc này. Vui lòng thử lại.'));
        },
      });
  }

  private resetAiSeoState(): void {
    this.aiSeoBusy.set(false);
    this.aiSeoError.set(null);
    this.aiSeoSuccess.set(null);
    this.aiSeoResult.set(null);
  }

  private resetImageEditor(): void {
    this.sourceFile.set(null);
    this.imageApprovals.set([]);
    this.imageIndex.set(0);
    this.imageNote.set(null);
    this.sourceApproved.set(false);
    this.aiImageBusy.set(false);
    this.aiEnhanceBusy.set(false);
    this.aiImageError.set(null);
    this.aiImageAnalysis.set(null);
    this.aiEnhanceResult.set(null);
    this.uploadedImageDataUrl.set('');
  }

  /** Bulk generation uses saved product identifiers and their optimistic locks only. */
  toggleContentProduct(product: AdminProductRow, event: Event): void {
    if (product.version == null || !this.canMutate()) return;
    const checked = (event.target as HTMLInputElement).checked;
    this.bulkSelection.update(rows => checked
      ? [...rows.filter(row => row.productId !== product.product_id), { productId: product.product_id, expectedVersion: product.version! }]
      : rows.filter(row => row.productId !== product.product_id));
  }

  /** Membership is derived from the selection, not a template-side array filter. */
  contentProductSelected(id: string): boolean { return this.bulkSelection().some(row => row.productId === id); }

  /** Publication and verified-fact changes reread saved content and its new lock instead of overwriting it locally. */
  reloadContentProduct(id: string): void {
    this.resetImageEditor();
    this.adminApi.getProduct(id).subscribe({
      next: row => {
        if (this.selected()?.product_id === id) this.selected.set(row);
        this.bulkSelection.update(rows => rows.map(item => item.productId === id && row.version != null
          ? { productId: id, expectedVersion: row.version } : item));
        this.reloadCatalog();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  onCsvFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const csv = String(reader.result || '');
      this.csvPreview.set(csv);
      this.csvRows.set([]);
      this.csvErrors.set([]);
      this.adminApi.previewCsv(csv).subscribe({
        next: (result) => {
          const preview = (result || {}) as CsvPreviewResult;
          this.csvRows.set(preview.rows || []);
          this.csvErrors.set(preview.errors || []);
          this.csvValidRows.set(preview.validRows || 0);
          this.csvTotalRows.set(preview.totalRows || 0);
          const errorCount = (preview.errors || []).length;
          this.csvMessage.set(
            errorCount
              ? `Kiểm tra xong: ${preview.validRows || 0}/${preview.totalRows || 0} dòng hợp lệ, ${errorCount} dòng lỗi.`
              : `Kiểm tra xong: ${preview.validRows || 0} dòng hợp lệ, có thể ghi catalog.`,
          );
        },
        error: (error: unknown) => {
          this.csvRows.set([]);
          this.csvErrors.set([]);
          this.csvMessage.set(adminErrorMessage(error, 'Không kiểm tra được CSV.'));
        },
      });
    };
    reader.readAsText(file);
  }

  /**
   * Commits the last previewed CSV through the original import API.
   */
  commitCsv(): void {
    const csv = this.csvPreview();
    if (!csv) {
      this.csvMessage.set('Chưa chọn file CSV.');
      return;
    }
    if (this.csvHasErrors()) {
      this.csvMessage.set('Sửa các dòng lỗi trước khi ghi catalog.');
      return;
    }
    this.adminApi.commitCsv(csv).subscribe({
      next: (result) => {
        if (!result || typeof result !== 'object' || !('failed' in result) || typeof result.failed !== 'number' || !Number.isSafeInteger(result.failed) || result.failed < 0) {
          this.csvMessage.set('Chưa xác minh được kết quả nhập. Giữ CSV để đối chiếu trước khi gửi lại.');
          return;
        }
        if (result.failed > 0) {
          this.csvMessage.set(`Có ${result.failed} dòng ghi thất bại. Các dòng đã ghi vẫn được giữ; đối chiếu kết quả trước khi gửi lại.`);
          this.reloadCatalog();
          return;
        }
        this.csvMessage.set('Đã ghi CSV vào catalog.');
        this.csvRows.set([]);
        this.csvPreview.set('');
        this.reloadCatalog();
      },
      error: (error: unknown) => this.csvMessage.set(adminErrorMessage(error, 'Cần đăng nhập quản trị rồi mới ghi CSV.')),
    });
  }

  /**
   * Builds a URL slug from the product name for create forms.
   */
  slugFromName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  /**
   * Reloads the server-paged catalog list and KPI counts.
   */
  reloadCatalog(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const params = {
      q: this.query(),
      categoryId: this.categoryId(),
      status: this.status(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    const listProducts = (filters: Record<string, string>) => this.priceOnly() ? this.adminApi.listPricingProducts(filters) : this.adminApi.listProducts(filters);
    this.listRequest = forkJoin({
      list: listProducts(params).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được danh mục sản phẩm.'));
          return of({ rows: [] as AdminProductRow[], count: 0 });
        }),
      ),
      onSale: listProducts({ status: 'on_sale', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminProductRow[], count: 0 }))),
      hidden: listProducts({ status: 'hidden', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminProductRow[], count: 0 }))),
      out: listProducts({ status: 'out_of_stock', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminProductRow[], count: 0 }))),
      low: this.canReadCatalog() ? this.adminApi.listLowStock().pipe(catchError(() => of({ rows: [] as AdminProductRow[], count: 0 }))) : of({ rows: [] as AdminProductRow[], count: 0 }),
    }).subscribe((payload) => {
      this.products.set(adminListRows(payload.list));
      this.total.set(adminListCount(payload.list));
      this.onSale.set(adminListCount(payload.onSale));
      this.hidden.set(adminListCount(payload.hidden));
      this.outOfStock.set(adminListCount(payload.out));
      this.lowStockCount.set(adminListRows(payload.low).length);
      this.loading.set(false);
        this.hasLoadedOnce.set(true);
    });
  }

  private loadLogs(): void {
    this.logsLoading.set(true);
    this.adminApi
      .listProductAuditLogs({
        limit: String(this.logsPageSize),
        offset: adminOffset(this.logsPage(), this.logsPageSize),
      })
      .subscribe({
        next: (payload) => {
          this.logs.set(adminListRows(payload));
          this.logsTotal.set(adminListCount(payload));
          this.logsLoading.set(false);
        },
        error: (error: unknown) => {
          this.csvMessage.set(adminErrorMessage(error));
          this.logsLoading.set(false);
        },
      });
  }
}
