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

/**
 * Catalog ViewModel: server-paged list, product editor, variants/stock, CSV, audit.
 */
@Component({
  selector: 'app-admin-products-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination, RouterLink],
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
  readonly loadError = signal<string | null>(null);
  readonly csvMessage = signal('Chưa có file được kiểm tra.');
  readonly csvPreview = signal('');
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsLoading = signal(false);
  readonly selected = signal<AdminProductRow | null>(null);
  readonly overlay = signal<ProductOverlay>(null);
  readonly actionError = signal<string | null>(null);
  readonly nextStatus = signal('');
  readonly priceHistory = signal<AdminPriceHistoryRow[]>([]);
  readonly canMutate = computed(() => this.session.canMutate('products'));

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'sản phẩm'));

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
    if (tab === 'logs' && !this.logs().length) {
      this.loadLogs();
    }
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
    });
  }

  /**
   * Opens the original product status modal.
   */
  openStatus(product: AdminProductRow): void {
    this.selected.set(product);
    this.nextStatus.set(product.status === 'on_sale' ? 'hidden' : 'on_sale');
    this.overlay.set('status');
    this.actionError.set(null);
  }

  /**
   * Opens stock adjustment for the first or selected variant.
   */
  openStock(product: AdminProductRow): void {
    this.selected.set(product);
    this.overlay.set('stock');
    this.actionError.set(null);
    this.adminApi.listVariants(product.product_id).subscribe({
      next: (payload) => this.variants.set(adminListRows(payload)),
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
    const overlay = this.overlay();
    if (overlay === 'create') {
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
   * Adds a variant from the editor stock form.
   */
  submitVariant(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    if (!product) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const color = (form.elements.namedItem('color') as HTMLInputElement).value.trim();
    const size = (form.elements.namedItem('size') as HTMLInputElement).value.trim();
    const stockQuantity = Number((form.elements.namedItem('stockQuantity') as HTMLInputElement).value || 0);
    const lowStockThreshold = Number((form.elements.namedItem('lowStockThreshold') as HTMLInputElement).value || 5);
    this.adminApi
      .createVariant(product.product_id, { color, size, stockQuantity, lowStockThreshold })
      .subscribe({
        next: () => this.openEdit(product),
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
  }

  /**
   * Applies a stock delta on one variant.
   */
  submitStock(event: Event): void {
    event.preventDefault();
    const product = this.selected();
    if (!product) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const variantId = (form.elements.namedItem('variantId') as HTMLSelectElement).value;
    const delta = Number((form.elements.namedItem('delta') as HTMLInputElement).value);
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement).value.trim();
    const variant = this.variants().find((row) => row.variant_id === variantId);
    this.adminApi
      .updateStock(product.product_id, {
        variantId,
        delta,
        reason,
        expectedVersion: variant?.version ?? 1,
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
    const status = (form.elements.namedItem('status') as HTMLSelectElement).value;
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement).value.trim();
    this.adminApi.changeProductStatus(product.product_id, { status, reason, expectedVersion: product.version }).subscribe({
      next: () => {
        this.closeOverlays();
        this.reloadCatalog();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Reads a local CSV file and previews it through the original import API.
   */
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
      this.adminApi.previewCsv(csv).subscribe({
        next: (result) => {
          this.csvMessage.set(JSON.stringify(result));
        },
        error: (error: unknown) => this.csvMessage.set(adminErrorMessage(error, 'Cần đăng nhập quản trị rồi mới nhập CSV.')),
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
    this.adminApi.commitCsv(csv).subscribe({
      next: (result) => this.csvMessage.set(JSON.stringify(result)),
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
    });
  }

  private loadLogs(): void {
    this.logsLoading.set(true);
    this.adminApi.listProductAuditLogs({ limit: '100' }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsLoading.set(false);
      },
      error: (error: unknown) => {
        this.csvMessage.set(adminErrorMessage(error));
        this.logsLoading.set(false);
      },
    });
  }
}
