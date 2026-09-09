import { Component, computed, inject, signal } from '@angular/core';
import { AdminApiService, AdminAuditRow, AdminProductRow } from '../../core/admin-api.service';
import { adminDateTime } from '../../core/admin-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type ProductTab = 'catalog' | 'csv' | 'logs';

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

@Component({
  selector: 'app-admin-products-page',
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-products.page.html',
})
export class AdminProductsPage {
  private readonly adminApi = inject(AdminApiService);

  readonly tab = signal<ProductTab>('catalog');
  readonly products = signal<AdminProductRow[]>([]);
  readonly lowStockCount = signal(0);
  readonly query = signal('');
  readonly category = signal('');
  readonly status = signal('');
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly csvMessage = signal('Chưa có file được kiểm tra.');
  readonly csvPreview = signal('');
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly selected = signal<AdminProductRow | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly nextStatus = signal('');

  readonly categories = computed(() => {
    const names = this.products()
      .map((row) => row.category_name)
      .filter((name): name is string => Boolean(name));
    return [...new Set(names)];
  });

  readonly filtered = computed(() => {
    const q = this.query().toLowerCase();
    const category = this.category();
    const status = this.status();
    return this.products().filter((row) => {
      const haystack = `${row.name} ${row.sku || ''}`.toLowerCase();
      if (q && !haystack.includes(q)) {
        return false;
      }
      if (category && row.category_name !== category) {
        return false;
      }
      if (status && row.status !== status) {
        return false;
      }
      return true;
    });
  });

  readonly total = computed(() => this.products().length);
  readonly onSale = computed(() => this.products().filter((item) => item.status === 'on_sale').length);
  readonly hidden = computed(() => this.products().filter((item) => item.status === 'hidden').length);
  readonly outOfStock = computed(() => this.products().filter((item) => item.status === 'out_of_stock').length);
  readonly paged = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.filtered().slice(start, start + this.pageSize);
  });
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize)));
  readonly rangeLabel = computed(() => {
    const total = this.filtered().length;
    if (!total) {
      return 'Hiển thị 0 - 0 / 0 sản phẩm';
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} sản phẩm`;
  });

  constructor() {
    this.reloadCatalog();
  }

  /**
   * Switches catalog / CSV / log tabs.
   */
  setTab(tab: ProductTab): void {
    this.tab.set(tab);
    if (tab === 'logs' && !this.logs().length) {
      this.adminApi.listProductAuditLogs({ limit: '100' }).subscribe({
        next: (payload) => this.logs.set(adminListRows(payload)),
        error: (error: unknown) => this.csvMessage.set(adminErrorMessage(error)),
      });
    }
  }

  /**
   * Applies the original product search field.
   */
  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value.trim());
    this.page.set(1);
  }

  /**
   * Applies category filter from the original select.
   */
  onCategory(event: Event): void {
    this.category.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
  }

  /**
   * Applies status filter from the original select.
   */
  onStatus(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
  }

  /**
   * Clears the original filter bar.
   */
  resetFilters(): void {
    this.query.set('');
    this.category.set('');
    this.status.set('');
    this.page.set(1);
  }

  /**
   * Moves catalog pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
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
   * Formats an ISO timestamp with the original admin locale.
   */
  updatedAt(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Opens the original product status modal.
   */
  openStatus(product: AdminProductRow): void {
    this.selected.set(product);
    this.nextStatus.set(product.status === 'on_sale' ? 'hidden' : 'on_sale');
    this.actionError.set(null);
  }

  /**
   * Closes the product status modal.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionError.set(null);
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

  private reloadCatalog(): void {
    this.adminApi.listProducts({ limit: '1000' }).subscribe({
      next: (payload) => this.products.set(adminListRows(payload)),
      error: (error: unknown) => this.csvMessage.set(adminErrorMessage(error, 'Không tải được danh mục sản phẩm.')),
    });
    this.adminApi.listLowStock().subscribe({
      next: (payload) => this.lowStockCount.set(adminListRows(payload).length),
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
}
