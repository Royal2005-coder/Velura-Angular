import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminOrderAction,
  AdminOrderActionResult,
  AdminOrderEvent,
  AdminOrderPayment,
  AdminOrderRow,
  AdminOrderSummary,
} from '../../core/admin-api.service';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import {
  CARRIER_SIMULATION_OUTCOMES,
  ORDER_CALL_RESULTS,
  ORDER_CANCEL_REASONS,
  ORDER_STATUS_LABELS,
  statusLabelFrom,
} from '../../core/admin-status-labels';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';
import { AdminTableSkeleton } from '../../shared/admin-table-skeleton';

type OrderTab = 'all' | 'attention' | 'payment' | 'cancelled' | 'logs';

/** Modal đang mở: một action của đơn, hoặc đối soát thanh toán. */
type OrderModal = { kind: 'action'; action: AdminOrderAction } | { kind: 'payment' } | null;

/** Lỗi mà trạng thái trên màn đã cũ so với dữ liệu thật: tải lại đơn rồi báo. */
const STALE_ORDER_CODES = new Set(['VERSION_CONFLICT', 'INVALID_ORDER_ACTION', 'ORDER_ALREADY_HANDED_OVER', 'PAYMENT_VERSION_CONFLICT']);

/** Nhãn của action trong lịch sử xử lý, gồm cả action của System. */
const EVENT_LABELS: Readonly<Record<string, string>> = {
  order_created: 'Tạo đơn',
  call_confirm: 'Gọi xác nhận',
  confirm_cod: 'Xác nhận đơn',
  auto_confirm_cod: 'Tự xác nhận COD',
  start_processing: 'Bắt đầu chuẩn bị hàng',
  record_shortage: 'Ghi nhận thiếu hàng',
  upsert_shipment: 'Tạo/cập nhật vận đơn',
  confirm_handover: 'Bàn giao ĐVVC',
  carrier_note: 'Ghi chú liên hệ ĐVVC',
  update_tracking: 'Cập nhật tracking',
  carrier_delivered: 'ĐVVC báo giao thành công',
  carrier_failed_returned: 'ĐVVC báo giao thất bại, hoàn hàng',
  carrier_failed_retrying: 'ĐVVC báo giao thất bại, giao lại',
  record_failure_reason: 'Ghi lý do giao thất bại',
  confirm_return_to_stock: 'Xác nhận hàng hoàn kho',
  cancel: 'Hủy đơn',
  customer_cancel: 'Khách hủy đơn',
  to_waiting_payment: 'Chờ thanh toán',
  payment_succeeded: 'Thanh toán thành công',
  payment_expired: 'Hết hạn thanh toán',
  retry_refund: 'Thử hoàn tiền lại',
  refund_failed: 'Hoàn tiền lỗi',
};

@Component({
  selector: 'app-admin-orders-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination, AdminTableSkeleton],
  templateUrl: './admin-orders.page.html',
})
export class AdminOrdersPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly callResults = ORDER_CALL_RESULTS;
  readonly cancelReasons = ORDER_CANCEL_REASONS;
  readonly carrierOutcomes = CARRIER_SIMULATION_OUTCOMES;

  readonly tab = signal<OrderTab>('all');
  readonly query = signal('');
  readonly status = signal('');
  readonly paymentMethod = signal('');
  readonly from = signal('');
  readonly rows = signal<AdminOrderRow[]>([]);
  readonly count = signal(0);
  readonly summary = signal<AdminOrderSummary | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  /**
   * Khung xương chỉ hiện ở lần tải đầu. Từ lần sau, bảng cũ vẫn ở nguyên chỗ và
   * chỉ mờ đi — thay cả bảng bằng khung xương ở mỗi lần lọc hay sang trang là bắt
   * người vận hành mất chỗ đang nhìn.
   */
  readonly hasLoadedOnce = signal(false);
  readonly showSkeleton = computed(() => this.loading() && !this.hasLoadedOnce());
  readonly isRefreshing = computed(() => this.loading() && this.hasLoadedOnce());
  readonly page = signal(1);
  readonly pageSize = 10;

  readonly selected = signal<AdminOrderRow | null>(null);
  readonly detailLoading = signal(false);
  readonly modal = signal<OrderModal>(null);
  readonly cancelReason = signal('');
  readonly actionError = signal<string | null>(null);
  /** Báo sau một action: đơn đã đổi dưới tay, hoặc kết quả hoàn tiền. */
  readonly notice = signal<string | null>(null);
  readonly submitting = signal(false);

  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsPage = signal(1);
  readonly logsCount = signal(0);

  readonly canMutate = computed(() => this.session.canMutate('orders'));
  readonly statusOptions = computed(() =>
    this.summary()?.by_status ?? Object.entries(ORDER_STATUS_LABELS).map(([status, label]) => ({ status, label, count: 0 })),
  );
  readonly attentionCount = computed(() => this.summary()?.attention ?? 0);
  readonly cancelledCount = computed(() => this.summary()?.by_status.find((row) => row.status === 'cancelled')?.count ?? 0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.count() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.count(), this.page(), this.pageSize, 'đơn hàng'));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));

  readonly selectedItems = computed(() => this.selected()?.items || []);
  /** Action thường, theo thứ tự API trả. Hủy đơn tách riêng thành nút nguy hiểm (FR-06). */
  readonly primaryActions = computed(() => (this.selected()?.allowed_actions || []).filter((action) => !action.destructive));
  readonly destructiveActions = computed(() => (this.selected()?.allowed_actions || []).filter((action) => action.destructive));
  readonly events = computed(() =>
    [...(this.selected()?.events || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
  );
  readonly selectedPayment = computed(() => {
    const order = this.selected();
    return order ? this.paymentOf(order) : null;
  });
  readonly canResolvePayment = computed(() => {
    const order = this.selected();
    return !!order && this.canMutate() && this.isPaymentError(order);
  });
  readonly activeAction = computed(() => {
    const modal = this.modal();
    return modal?.kind === 'action' ? modal.action : null;
  });

  constructor() {
    this.reload();
  }

  /**
   * Chuyển tab danh sách.
   */
  setTab(tab: OrderTab): void {
    this.tab.set(tab);
    this.page.set(1);
    if (tab === 'logs') {
      this.loadLogs();
      return;
    }
    this.reload();
  }

  /**
   * Tải danh sách từ `/api/v1/admin/orders` và số đếm từ `/summary`. Cả hai tab "Cần xử
   * lý" và "Lỗi thanh toán" đều lọc ở server, nên số đếm và phân trang đúng trên toàn bộ
   * đơn, không chỉ trên trang đang xem.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const tab = this.tab();
    const params: Record<string, string> = {
      q: this.query(),
      status: tab === 'cancelled' ? 'cancelled' : this.status(),
      paymentMethod: this.paymentMethod(),
      from: this.from(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    if (tab === 'attention') params['attention'] = 'true';
    if (tab === 'payment') params['tag'] = 'PAYMENT_ATTENTION';
    this.api
      .listOrders(params)
      .pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không thể tải đơn hàng'));
          return of({ rows: [] as AdminOrderRow[], count: 0 });
        }),
      )
      .subscribe((payload) => {
        this.rows.set(adminListRows(payload));
        this.count.set(adminListCount(payload));
        this.loading.set(false);
        this.hasLoadedOnce.set(true);
      });
    this.api
      .orderSummary()
      .pipe(catchError(() => of(null)))
      .subscribe((summary) => this.summary.set(Array.isArray(summary?.by_status) ? summary : null));
  }

  /**
   * Áp dụng thanh lọc.
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
   * Xoá thanh lọc.
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

  goPage(page: number): void {
    this.page.set(Math.min(this.totalPages(), Math.max(1, page)));
    this.reload();
  }

  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logPageCount(), Math.max(1, page)));
    this.loadLogs();
  }

  /**
   * Mở drawer chi tiết. Luôn đọc lại đơn: action hợp lệ tính theo dữ liệu mới nhất.
   */
  openDetail(orderId: string): void {
    this.notice.set(null);
    this.detailLoading.set(true);
    this.api.getOrder(orderId).subscribe({
      next: (order) => {
        this.selected.set(order);
        this.detailLoading.set(false);
      },
      error: (error: unknown) => {
        this.detailLoading.set(false);
        this.loadError.set(adminErrorMessage(error));
      },
    });
  }

  closeDetail(): void {
    this.selected.set(null);
    this.closeModal();
    this.notice.set(null);
  }

  openAction(action: AdminOrderAction): void {
    this.modal.set({ kind: 'action', action });
    this.cancelReason.set('');
    this.actionError.set(null);
  }

  openPaymentResolve(): void {
    this.modal.set({ kind: 'payment' });
    this.actionError.set(null);
  }

  closeModal(): void {
    this.modal.set(null);
    this.actionError.set(null);
    this.submitting.set(false);
  }

  /**
   * Gửi action đang mở. Ghi chú bắt buộc (AC-17) được kiểm ở đây để khỏi tốn một lượt
   * gọi, và API kiểm lại.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const order = this.selected();
    const action = this.activeAction();
    if (!order || !action || this.submitting()) return;
    const body = actionBody(action, event.target as HTMLFormElement);
    const note = String(body['note'] || '');
    if (action.requires_note && note.length < 5) {
      this.actionError.set('Cần nhập ghi chú (tối thiểu 5 ký tự).');
      return;
    }
    this.submitting.set(true);
    this.api.performOrderAction(order.order_id, action.code, { ...body, expectedVersion: order.version }).subscribe({
      next: (result) => this.afterAction(result),
      error: (error: unknown) => this.handleActionError(order.order_id, error),
    });
  }

  /**
   * Đối soát thanh toán bằng tay (đánh dấu đã trả hoặc thất bại).
   */
  submitPaymentResolve(event: Event): void {
    event.preventDefault();
    const order = this.selected();
    const payment = this.selectedPayment();
    if (!order || this.submitting()) return;
    if (!payment?.payment_id) {
      this.actionError.set('Đơn hàng không có thanh toán để đối soát.');
      return;
    }
    const form = event.target as HTMLFormElement;
    this.submitting.set(true);
    this.api
      .resolvePayment(order.order_id, payment.payment_id, {
        decision: (form.elements.namedItem('decision') as HTMLSelectElement | null)?.value || '',
        reason: (form.elements.namedItem('reason') as HTMLTextAreaElement | null)?.value.trim() || '',
        expectedOrderVersion: order.version,
        expectedPaymentVersion: payment.version ?? 1,
      })
      .subscribe({
        next: () => {
          this.closeModal();
          this.openDetail(order.order_id);
          this.reload();
        },
        error: (error: unknown) => this.handleActionError(order.order_id, error),
      });
  }

  /**
   * Panel mô phỏng ĐVVC của super_admin: sinh kết quả giao hàng, ghi là System.
   */
  simulateCarrier(outcome: string): void {
    const order = this.selected();
    if (!order || this.submitting()) return;
    this.submitting.set(true);
    this.notice.set(null);
    this.api.simulateCarrier(order.order_id, { outcome }).subscribe({
      next: (fresh) => {
        this.submitting.set(false);
        this.selected.set(fresh);
        this.reload();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.notice.set(adminErrorMessage(error));
      },
    });
  }

  isPaymentError(order: AdminOrderRow): boolean {
    return (order.tags || []).some((tag) => tag.code === 'PAYMENT_ATTENTION');
  }

  /** Payment mới nhất của đơn — đơn thanh toán lại có nhiều payment. */
  paymentOf(order: AdminOrderRow): AdminOrderPayment | null {
    const payments = Array.isArray(order.payments) ? order.payments : [];
    return [...payments].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] ?? null;
  }

  orderLabel(order: AdminOrderRow | null | undefined): string {
    return order?.status_label || statusLabelFrom(ORDER_STATUS_LABELS, order?.status);
  }

  statusName(status: string | null | undefined): string {
    return statusLabelFrom(ORDER_STATUS_LABELS, status);
  }

  paymentMethodLabel(method: string | undefined): string {
    return method === 'COD' ? 'COD' : method === 'ONLINE_PAYMENT' ? 'Online (Stripe)' : method || '—';
  }

  eventLabel(event: AdminOrderEvent): string {
    return EVENT_LABELS[event.action || ''] || event.action || '—';
  }

  eventActor(event: AdminOrderEvent): string {
    if (event.actor_type === 'system') return 'Hệ thống';
    if (event.actor_type === 'customer') return 'Khách hàng';
    return event.actor_role || 'Admin';
  }

  hasField(action: AdminOrderAction | null, field: string): boolean {
    return !!action && action.fields.includes(field as AdminOrderAction['fields'][number]);
  }

  money(value: number | undefined | null): string {
    return `${Number(value || 0).toLocaleString('vi-VN')}đ`;
  }

  lineTotal(unitPrice: number | undefined, quantity: number | undefined): string {
    return this.money(Number(unitPrice || 0) * Number(quantity || 0));
  }

  dateTime(value: string | undefined | null): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
  }

  /**
   * Xuất bảng đang lọc ra CSV.
   */
  exportCsv(): void {
    const rows = [
      ['order_code', 'order_date', 'status', 'payment_status', 'shipping_name', 'shipping_phone', 'total_amount'],
      ...this.rows().map((order) => [
        order.order_code || order.order_id,
        order.order_date || '',
        this.orderLabel(order),
        order.payment_status_label || '',
        order.shipping_name || '',
        order.shipping_phone || '',
        String(order.total_amount || 0),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `velura-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private afterAction(result: AdminOrderActionResult): void {
    this.closeModal();
    this.selected.set(result.order);
    this.notice.set(refundNotice(result.refund));
    this.reload();
  }

  /**
   * Lỗi do dữ liệu trên màn đã cũ (người khác vừa xử lý, hoặc action không còn hợp lệ):
   * đóng modal, tải lại đơn và nói rõ cho người vận hành (Userflow quy tắc 4).
   */
  private handleActionError(orderId: string, error: unknown): void {
    this.submitting.set(false);
    const message = adminErrorMessage(error);
    if (STALE_ORDER_CODES.has(errorCode(error))) {
      this.closeModal();
      this.openDetail(orderId);
      this.reload();
      this.notice.set(`${message} Màn hình đã tải lại trạng thái mới nhất.`);
      return;
    }
    this.actionError.set(message);
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

/** Đọc form của một action thành body của `POST /actions/:action`. */
function actionBody(action: AdminOrderAction, form: HTMLFormElement): Record<string, string> {
  const value = (name: string) =>
    ((form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value || '').trim();
  const checked = (form.querySelector('input[name="callResult"]:checked') as HTMLInputElement | null)?.value || '';
  const body: Record<string, string> = { note: value('note') };
  if (action.fields.includes('call_result')) body['callResult'] = checked;
  if (action.fields.includes('shortage')) body['shortage'] = value('shortage');
  if (action.fields.includes('shipment') || action.fields.includes('tracking')) {
    body['trackingCode'] = value('trackingCode');
    body['trackingUrl'] = value('trackingUrl');
    body['carrier'] = value('carrier');
  }
  if (action.fields.includes('cancel_reason')) body['cancelReason'] = value('cancelReason');
  return body;
}

function errorCode(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return '';
  const payload = error.error as { error?: { code?: string } | string } | null;
  return typeof payload?.error === 'object' ? payload.error?.code || '' : '';
}

function refundNotice(refund: AdminOrderActionResult['refund']): string | null {
  if (!refund) return null;
  switch (refund.status) {
    case 'refunded':
      return 'Đã hoàn tiền cho khách qua Stripe.';
    case 'requested':
      return 'Đã gửi yêu cầu hoàn tiền tới Stripe, chờ Stripe xác nhận.';
    case 'failed':
      return `Hoàn tiền chưa thành công: ${refund.message || 'Stripe từ chối'}. Đơn gắn cảnh báo "Hoàn tiền lỗi", dùng "Thử hoàn tiền lại".`;
    default:
      return null;
  }
}
