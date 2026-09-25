import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminCategoryRow,
  AdminPriceHistoryRow,
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

/**
 * Catalog ViewModel: server-paged list, product editor, variants/stock, CSV, audit.
 */
@Component({
  selector: 'app-admin-products-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination, RouterLink, AdminTableSkeleton],
  templateUrl: './admin-products.page.html',
})
export class AdminProductsPage {
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
  readonly imageUploading = signal(false);
  readonly canMutate = computed(() => this.session.canMutate('products'));
  readonly canOpenPricing = computed(() => this.session.canOpen('pricing'));

  // Signals cho thêm biến thể trong drawer Chi tiết sản phẩm
  readonly newVariantColor = signal('');
  readonly newVariantSize = signal('');
  readonly newVariantStock = signal(0);
  readonly newVariantThreshold = signal(5);

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
    this.reloadCatalog();
    this.adminApi.listCategories().subscribe({
      next: (payload) => this.categories.set(adminListRows(payload)),
    });
  }

  /**
   * Switches catalog / CSV / log tabs.
   */
  setTab(tab: ProductTab): void {
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
   * Read-only catalog price. Mutations belong on `/pricing`.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Opens create overlay with an empty form.
   */
  openCreate(): void {
    this.selected.set(null);
    this.variants.set([]);
    this.priceHistory.set([]);
    this.overlay.set('create');
    this.actionError.set(null);
  }

  /**
   * Loads product detail + variants into the editor drawer.
   */
  openEdit(product: AdminProductRow): void {
    this.actionError.set(null);
    this.overlay.set('edit');
    this.priceHistory.set([]);
    this.adminApi.getProduct(product.product_id).subscribe({
      next: (row) => {
        this.selected.set(row);
        this.variants.set(row.variants || []);
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
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const sku = (form.elements.namedItem('sku') as HTMLInputElement).value.trim().toUpperCase();
    const slug = (form.elements.namedItem('slug') as HTMLInputElement).value.trim().toLowerCase() || this.slugFromName(name);
    const categoryId = (form.elements.namedItem('categoryId') as HTMLSelectElement).value;
    const collection = (form.elements.namedItem('collection') as HTMLInputElement).value.trim();
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim();
    const imagesRaw = (form.elements.namedItem('images') as HTMLTextAreaElement).value.trim();
    const images = imagesRaw
      ? imagesRaw
          .split(/\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
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
      const basePrice = Number((form.elements.namedItem('basePrice') as HTMLInputElement).value);
      const salePrice = Number((form.elements.namedItem('salePrice') as HTMLInputElement).value || basePrice);
      const status = (form.elements.namedItem('createStatus') as HTMLSelectElement).value || 'on_sale';
      const initialStock = Number((form.elements.namedItem('initialStock') as HTMLInputElement).value || 0);
      this.adminApi
        .createProduct({
          sku,
          name,
          slug,
          categoryId,
          basePrice,
          salePrice,
          status,
          collection,
          description,
          images,
          initialStock,
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
    this.adminApi
      .updateProduct(product.product_id, {
        name,
        categoryId,
        collection,
        description,
        images,
        expectedVersion: product.version,
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
      this.actionError.set('Vui lòng nhập màu sắc và kích thước cho biến thể mới.');
      return;
    }
    this.adminApi
      .createVariant(product.product_id, {
        color,
        size,
        stockQuantity: this.newVariantStock(),
        lowStockThreshold: this.newVariantThreshold(),
      })
      .subscribe({
        next: () => {
          this.newVariantColor.set('');
          this.newVariantSize.set('');
          this.newVariantStock.set(0);
          this.newVariantThreshold.set(5);
          this.actionError.set(null);
          this.openEdit(product);
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
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

  /**
   * Reads a local CSV file and previews it through the original import API.
   */
  /**
   * Uploads one catalog photo and appends its public URL to the image list.
   */
  uploadImage(event: Event, images: HTMLTextAreaElement): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.imageUploading()) {
      return;
    }
    this.imageUploading.set(true);
    this.actionError.set(null);
    this.adminApi.uploadProductImage(file).subscribe({
      next: (result) => {
        this.imageUploading.set(false);
        const url = result.url || '';
        if (!url) {
          this.actionError.set('Kho ảnh không trả về đường dẫn.');
          return;
        }
        const current = images.value.trim();
        images.value = current ? `${current}\n${url}` : url;
      },
      error: (error: unknown) => {
        this.imageUploading.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không tải được ảnh sản phẩm.'));
      },
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
        this.csvMessage.set('Đã ghi CSV vào catalog.');
        this.csvRows.set([]);
        this.csvPreview.set('');
        this.reloadCatalog();
        void result;
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
    this.loading.set(true);
    this.loadError.set(null);
    const params = {
      q: this.query(),
      categoryId: this.categoryId(),
      status: this.status(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    forkJoin({
      list: this.adminApi.listProducts(params).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được danh mục sản phẩm.'));
          return of({ rows: [] as AdminProductRow[], count: 0 });
        }),
      ),
      onSale: this.adminApi.listProducts({ status: 'on_sale', limit: '1' }).pipe(catchError(() => of({ rows: [], count: 0 }))),
      hidden: this.adminApi.listProducts({ status: 'hidden', limit: '1' }).pipe(catchError(() => of({ rows: [], count: 0 }))),
      out: this.adminApi.listProducts({ status: 'out_of_stock', limit: '1' }).pipe(catchError(() => of({ rows: [], count: 0 }))),
      low: this.adminApi.listLowStock().pipe(catchError(() => of({ rows: [] as AdminProductRow[] }))),
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
