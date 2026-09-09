import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminAuditRow, AdminOrderPayment, AdminOrderRow } from '../../core/admin-api.service';
import { adminErrorMessage, adminListCount, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type OrderTab = 'all' | 'attention' | 'payment' | 'cancelled' | 'logs';

const ORDER_LABELS: Record<string, string> = {
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị',
  shipping: 'Đang giao',
  delivered: 'Đã giao',
  failed_delivery: 'Giao thất bại',
  cancelled: 'Đã hủy',
  completed: 'Hoàn thành',
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: 'Đã thanh toán',
  failed: 'Thanh toán thất bại',
  pending: 'Chờ xử lý',
  refunded: 'Đã hoàn tiền',
  refund_pending: 'Chờ hoàn tiền',
  discrepancy: 'Cần đối soát',
};

const TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed'],
  confirmed: ['preparing'],
  preparing: ['shipping'],
  shipping: ['delivered', 'failed_delivery'],
  failed_delivery: ['shipping'],
  delivered: ['completed'],
};

const CANCELLABLE = ['pending', 'confirmed', 'preparing', 'failed_delivery'];

@Component({
  selector: 'app-admin-orders-page',
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-orders.page.html',
})
export class AdminOrdersPage {
  private readonly api = inject(AdminApiService);

  readonly tab = signal<OrderTab>('all');
  readonly query = signal('');
  readonly status = signal('');
  readonly paymentMethod = signal('');
  readonly from = signal('');
  readonly rows = signal<AdminOrderRow[]>([]);
  readonly count = signal(0);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly selected = signal<AdminOrderRow | null>(null);
  readonly actionType = signal<'status' | 'cancel' | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsPage = signal(1);
  readonly menuId = signal<string | null>(null);

  readonly pendingCount = computed(() => this.rows().filter((row) => row.status === 'pending').length);
  readonly paymentErrorCount = computed(() => this.rows().filter((row) => this.isPaymentError(row)).length);
  readonly attentionCount = computed(() => this.rows().filter((row) => this.needsAttention(row)).length);
  readonly cancelledCount = computed(() => this.rows().filter((row) => row.status === 'cancelled').length);
  readonly filtered = computed(() => {
    const tab = this.tab();
    if (tab === 'attention') {
      return this.rows().filter((row) => this.needsAttention(row));
    }
    if (tab === 'payment') {
      return this.rows().filter((row) => this.isPaymentError(row));
    }
    if (tab === 'cancelled') {
      return this.rows().filter((row) => row.status === 'cancelled');
    }
    return this.rows();
  });
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize)));
  readonly paged = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.filtered().slice(start, start + this.pageSize);
  });
  readonly rangeLabel = computed(() => {
    const total = this.filtered().length;
    if (!total) {
      return 'Hiển thị 0 - 0 / 0 đơn hàng';
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} đơn hàng`;
  });
  readonly pagedLogs = computed(() => {
    const start = (this.logsPage() - 1) * this.pageSize;
    return this.logs().slice(start, start + this.pageSize);
  });
  readonly nextStatuses = computed(() => TRANSITIONS[this.selected()?.status || ''] || []);
  readonly selectedItems = computed(() => this.selected()?.items || []);
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logs().length / this.pageSize)));
  readonly logRangeLabel = computed(() => {
    const total = this.logs().length;
    if (!total) {
      return 'Hiển thị 0 - 0 / 0 nhật ký';
    }
    const start = (this.logsPage() - 1) * this.pageSize + 1;
    const end = Math.min(this.logsPage() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} nhật ký`;
  });

  constructor() {
    this.reload();
  }

  /**
   * Switches the original order tablist.
   */
  setTab(tab: OrderTab): void {
    this.tab.set(tab);
    this.page.set(1);
    this.menuId.set(null);
    if (tab === 'logs' && !this.logs().length) {
      this.loadLogs();
    }
  }

  /**
   * Reloads orders from `/api/v1/admin/orders`.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .listOrders({
        q: this.query(),
        status: this.status(),
        paymentMethod: this.paymentMethod(),
        from: this.from(),
        limit: '1000',
      })
      .subscribe({
        next: (payload) => {
          const rows = adminListRows(payload);
          this.rows.set(rows);
          this.count.set(adminListCount(payload));
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không thể tải đơn hàng'));
          this.loading.set(false);
        },
      });
  }

  /**
   * Applies the original order filter bar.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.status.set((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '');
    this.paymentMethod.set((form.elements.namedItem('paymentMethod') as HTMLSelectElement | null)?.value || '');
    this.from.set((form.elements.namedItem('from') as HTMLInputElement | null)?.value || '');
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears the original filter bar.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.status.set('');
    this.paymentMethod.set('');
    this.from.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves order pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.totalPages(), Math.max(1, page)));
  }

  /**
   * Moves order-log pagination.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logPageCount(), Math.max(1, page)));
  }

  /**
   * Opens or closes the original row action menu.
   */
  toggleMenu(orderId: string): void {
    this.menuId.update((current) => (current === orderId ? null : orderId));
  }

  /**
   * Opens the original order detail drawer.
   */
  openDetail(orderId: string): void {
    this.menuId.set(null);
    this.api.getOrder(orderId).subscribe({
      next: (order) => this.selected.set(order),
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Closes the detail drawer and action modal.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionType.set(null);
    this.actionError.set(null);
  }

  /**
   * Opens the original status/cancel modal for the selected row.
   */
  openAction(type: 'status' | 'cancel', orderId: string): void {
    const order = this.rows().find((row) => row.order_id === orderId) || null;
    this.selected.set(order);
    this.actionType.set(type);
    this.actionError.set(null);
    this.menuId.set(null);
  }

  /**
   * Submits a status change or cancel through the original admin APIs.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const order = this.selected();
    if (!order) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement | null)?.value || '';
    const status = (form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '';
    const request$ =
      this.actionType() === 'cancel'
        ? this.api.cancelOrder(order.order_id, { reason, expectedVersion: order.version })
        : this.api.changeOrderStatus(order.order_id, { status, reason, expectedVersion: order.version });
    request$.subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Whether the row has a failed or discrepancy payment.
   */
  isPaymentError(order: AdminOrderRow): boolean {
    const payment = this.paymentOf(order);
    return payment?.payment_status === 'failed' || payment?.payment_status === 'discrepancy' || payment?.has_discrepancy === true;
  }

  /**
   * Whether the row belongs on the original "cần xử lý" tab.
   */
  needsAttention(order: AdminOrderRow): boolean {
    return order.status === 'pending' || order.status === 'failed_delivery' || this.isPaymentError(order);
  }

  /**
   * Whether the original cancel action is allowed.
   */
  canCancel(order: AdminOrderRow): boolean {
    return CANCELLABLE.includes(order.status || '');
  }

  /**
   * Whether the original status action has a next step.
   */
  canChangeStatus(order: AdminOrderRow): boolean {
    return (TRANSITIONS[order.status || ''] || []).length > 0;
  }

  /**
   * First payment record on the original order row.
   */
  paymentOf(order: AdminOrderRow): AdminOrderPayment | null {
    return Array.isArray(order.payments) ? order.payments[0] : null;
  }

  /**
   * Maps an order status to the original Vietnamese badge.
   */
  orderLabel(status: string | undefined): string {
    return ORDER_LABELS[status || ''] || status || '—';
  }

  /**
   * Maps a payment status to the original Vietnamese badge.
   */
  paymentLabel(status: string | undefined): string {
    return PAYMENT_LABELS[status || ''] || status || 'Chờ xử lý';
  }

  /**
   * Formats VND like vanilla orders.js.
   */
  money(value: number | undefined): string {
    return `${Number(value || 0).toLocaleString('vi-VN')}đ`;
  }

  /**
   * Line total for an order item in the original drawer.
   */
  lineTotal(unitPrice: number | undefined, quantity: number | undefined): string {
    return this.money(Number(unitPrice || 0) * Number(quantity || 0));
  }

  /**
   * Formats an ISO timestamp with the original admin locale.
   */
  dateTime(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
  }

  /**
   * Exports the filtered table as CSV like the original page.
   */
  exportCsv(): void {
    const rows = [
      ['order_id', 'order_date', 'status', 'shipping_name', 'shipping_phone', 'total_amount'],
      ...this.filtered().map((order) => [
        order.order_id,
        order.order_date || '',
        order.status || '',
        order.shipping_name || '',
        order.shipping_phone || '',
        String(order.total_amount || 0),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `velura-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private loadLogs(): void {
    const targets = this.rows().slice(0, 20);
    if (!targets.length) {
      this.logs.set([]);
      return;
    }
    forkJoin(
      targets.map((order) =>
        this.api.orderAuditLogs(order.order_id, { limit: '20' }).pipe(catchError(() => of({ rows: [] as AdminAuditRow[] }))),
      ),
    ).subscribe((results) => {
      const rows = results.flatMap((result) => adminListRows(result)).sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      this.logs.set(rows);
    });
  }
}
