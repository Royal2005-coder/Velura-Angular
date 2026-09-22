import { Component, computed, inject, signal } from '@angular/core';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminAuditRow, AdminOrderPayment, AdminOrderRow } from '../../core/admin-api.service';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import {
  ORDER_CANCELLABLE,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  PAYMENT_STATUS_LABELS,
  statusLabelFrom,
} from '../../core/admin-status-labels';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type OrderTab = 'all' | 'attention' | 'payment' | 'cancelled' | 'logs';
type OrderAction = 'status' | 'cancel' | 'payment' | null;


@Component({
  selector: 'app-admin-orders-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination],
  templateUrl: './admin-orders.page.html',
})
export class AdminOrdersPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly tab = signal<OrderTab>('all');
  readonly query = signal('');
  readonly status = signal('');
  readonly paymentMethod = signal('');
  readonly from = signal('');
  readonly rows = signal<AdminOrderRow[]>([]);
  readonly count = signal(0);
  readonly pendingCount = signal(0);
  readonly cancelledCount = signal(0);
  readonly paymentErrorCount = signal(0);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly selected = signal<AdminOrderRow | null>(null);
  readonly actionType = signal<OrderAction>(null);
  readonly actionError = signal<string | null>(null);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsPage = signal(1);
  readonly logsCount = signal(0);
  readonly menuId = signal<string | null>(null);
  readonly canMutate = computed(() => this.session.canMutate('orders'));
  readonly attentionCount = computed(() => this.pendingCount() + this.paymentErrorCount());
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.count() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.count(), this.page(), this.pageSize, 'đơn hàng'));
  readonly pagedLogs = computed(() => this.logs());
  readonly nextStatuses = computed(() => ORDER_TRANSITIONS[this.selected()?.status || ''] || []);
  readonly selectedItems = computed(() => this.selected()?.items || []);
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));
  readonly needsTracking = computed(() => this.nextStatuses().includes('shipping'));

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
    if (tab === 'logs') {
      this.loadLogs();
      return;
    }
    this.reload();
  }

  /**
   * Reloads orders from `/api/v1/admin/orders` with server pagination.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const tab = this.tab();
    let status = this.status();
    if (tab === 'cancelled') {
      status = 'cancelled';
    } else if (tab === 'attention') {
      status = status || 'pending';
    }
    this.api
      .listOrders({
        q: this.query(),
        status,
        paymentMethod: this.paymentMethod(),
        from: this.from(),
        limit: String(this.pageSize),
        offset: adminOffset(this.page(), this.pageSize),
      })
      .pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không thể tải đơn hàng'));
          return of({ rows: [] as AdminOrderRow[], count: 0 });
        }),
      )
      .subscribe((payload) => {
        const rows = adminListRows(payload);
        this.rows.set(tab === 'payment' ? rows.filter((row) => this.isPaymentError(row)) : rows);
        this.count.set(tab === 'payment' ? this.rows().length : adminListCount(payload));
        this.paymentErrorCount.set(rows.filter((row) => this.isPaymentError(row)).length);
        this.loading.set(false);
      });
    this.api.listOrders({ status: 'pending', limit: '1' }).subscribe({
      next: (payload) => this.pendingCount.set(adminListCount(payload)),
    });
    this.api.listOrders({ status: 'cancelled', limit: '1' }).subscribe({
      next: (payload) => this.cancelledCount.set(adminListCount(payload)),
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
    this.reload();
  }

  /**
   * Moves order-log pagination.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logPageCount(), Math.max(1, page)));
    this.loadLogs();
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
  openAction(type: OrderAction, orderId: string): void {
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
    const trackingCode = (form.elements.namedItem('trackingCode') as HTMLInputElement | null)?.value.trim() || '';
    const decision = (form.elements.namedItem('decision') as HTMLSelectElement | null)?.value || '';
    if (this.actionType() === 'payment') {
      const payment = this.paymentOf(order);
      if (!payment?.payment_id) {
        this.actionError.set('Đơn hàng không có thanh toán để đối soát.');
        return;
      }
      this.api
        .resolvePayment(order.order_id, payment.payment_id, {
          decision,
          reason,
          expectedOrderVersion: order.version,
          expectedPaymentVersion: payment.version ?? 1,
        })
        .subscribe({
          next: () => {
            this.closeOverlays();
            this.reload();
          },
          error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
        });
      return;
    }
    const request$ =
      this.actionType() === 'cancel'
        ? this.api.cancelOrder(order.order_id, { reason, expectedVersion: order.version })
        : this.api.changeOrderStatus(order.order_id, {
            status,
            reason,
            trackingCode: status === 'shipping' ? trackingCode : undefined,
            expectedVersion: order.version,
          });
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
    return ORDER_CANCELLABLE.includes(order.status || '');
  }

  /**
   * Whether the original status action has a next step.
   */
  canChangeStatus(order: AdminOrderRow): boolean {
    return (ORDER_TRANSITIONS[order.status || ''] || []).length > 0;
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
    return statusLabelFrom(ORDER_STATUS_LABELS, status);
  }

  /**
   * Maps a payment status to the original Vietnamese badge.
   *
   * Trạng thái lạ trả về nguyên mã. Trước đây mặc định là "Chờ xử lý", nên một
   * trạng thái thanh toán mà admin chưa biết sẽ hiện y hệt `pending` — người vận
   * hành đọc là đơn chưa trả tiền trong khi thực tế không ai biết nó đang ở đâu.
   */
  paymentLabel(status: string | undefined): string {
    return statusLabelFrom(PAYMENT_STATUS_LABELS, status);
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
      ...this.rows().map((order) => [
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
    this.api.listAuditLogs({ module: 'orders', limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
      },
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }
}
