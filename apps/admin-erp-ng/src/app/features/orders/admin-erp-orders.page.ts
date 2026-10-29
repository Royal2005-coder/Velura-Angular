import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, DestroyRef, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink, type ParamMap } from '@angular/router';
import { catchError, of } from 'rxjs';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminOrderAction,
  AdminOrderActionResult,
  AdminOrderPayment,
  AdminOrderRow,
  AdminOrderSummary,
  AdminReturnRow,
} from '../../core/admin-erp-api.service';
import {
  actionPrefill,
  auditTrace,
  eventTrace,
  handoverFollowUp,
  handoverNote,
  logsForOrderLink,
  mergeOrderTrace,
  returnsForOrderLink,
  returnTrace,
  type OrderTraceOrigin,
} from '../../core/admin-erp-order-trace';
import { choiceParam, textParam, watchQueryParams } from '../../core/admin-erp-deep-link';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import {
  CARRIER_PROFILES,
  buildOrderQrLink,
  buildShipmentQr,
  carrierLabel,
  demoShipmentFacts,
  deriveTrackingUrl,
  parseScan,
} from '../../core/admin-erp-qr';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import { ORDER_STATUS_LABELS, statusLabelFrom } from '../../core/admin-erp-status-labels';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpLoadingOverlay } from '../../shared/ui/admin-loading-overlay';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpQrCode } from '../../shared/ui/admin-qr-code';
import { AdminErpQrScan } from '../../shared/ui/admin-qr-scan';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type OrderTab = 'all' | 'attention' | 'payment' | 'cancelled' | 'logs';
type OrderModal =
  | { kind: 'action'; action: AdminOrderAction }
  | { kind: 'payment' }
  | { kind: 'cod_call'; order: AdminOrderRow }
  | null;

const STALE_ORDER_CODES = new Set(['VERSION_CONFLICT', 'INVALID_ORDER_ACTION', 'ORDER_ALREADY_HANDED_OVER', 'PAYMENT_VERSION_CONFLICT']);

const ORDER_TABS = ['all', 'attention', 'payment', 'cancelled', 'logs'] as const;

const CALL_RESULTS = [
  { code: 'reached', label: 'Liên hệ được' },
  { code: 'no_answer', label: 'Không nghe máy' },
  { code: 'customer_requests_cancel', label: 'Khách yêu cầu hủy' },
];
const CANCEL_REASONS = [
  { code: 'customer_request', label: 'Khách yêu cầu hủy' },
  { code: 'out_of_stock', label: 'Hết hàng, không thể giao' },
  { code: 'unreachable', label: 'Không liên hệ được khách' },
  { code: 'suspected_fraud', label: 'Nghi ngờ đơn ảo' },
  { code: 'other', label: 'Lý do khác' },
];
const CARRIER_OUTCOMES = [
  { code: 'delivered', label: 'Giao thành công' },
  { code: 'failed_retrying', label: 'Giao thất bại, giao lại' },
  { code: 'failed_returned', label: 'Giao thất bại, hoàn hàng' },
];

/**
 * Order operations workspace. Preserves the API state machine, COD call guard,
 * expectedVersion, payment reconciliation and audit. Shipment entry chains the handover the
 * API keeps as a second action, action forms open pre-filled with facts the order already
 * holds, and the drawer shows one linked trail (order events, audit, returns) with deep links.
 */
@Component({
  selector: 'app-admin-erp-orders-page',
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
    AdminErpQrCode,
    AdminErpQrScan,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-orders.page.html',
  styleUrl: './admin-erp-orders.page.scss',
})
export class AdminErpOrdersPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly tab = signal<OrderTab>('all');
  readonly query = signal('');
  readonly status = signal('');
  readonly paymentMethod = signal('');
  readonly from = signal('');
  readonly rows = signal<AdminOrderRow[]>([]);
  readonly count = signal(0);
  readonly summary = signal<AdminOrderSummary | null>(null);
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsCount = signal(0);
  readonly logsPage = signal(1);
  readonly selected = signal<AdminOrderRow | null>(null);
  readonly detailLoading = signal(false);
  readonly modal = signal<OrderModal>(null);
  readonly actionError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly audit = signal<AdminAuditRow[]>([]);
  readonly linkedReturns = signal<AdminReturnRow[]>([]);
  /** Ba trường của vận đơn; quét QR hoặc chọn ĐVVC ghi thẳng vào đây. */
  readonly shipment = signal({ carrier: '', trackingCode: '', trackingUrl: '' });
  readonly shipmentUrlEdited = signal(false);
  readonly scanOpen = signal(false);
  readonly scanError = signal<string | null>(null);
  readonly scanNotice = signal<string | null>(null);
  readonly carriers = CARRIER_PROFILES;
  readonly copiedPhone = signal(false);
  private copiedPhoneTimer: ReturnType<typeof setTimeout> | null = null;
  private detailRequestId = 0;
  readonly codDecision = signal<'' | 'confirm' | 'cancel' | 'no_answer' | 'invalid'>('');
  readonly codCancelReason = signal('customer_request');
  readonly codNote = signal('');
  readonly codCallStarted = signal(false);
  readonly canMutate = computed(() => this.session.can('update', 'orders'));
  readonly canReadReturns = computed(() => this.session.can('read', 'returns'));

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.count() },
    { key: 'attention', label: 'Cần xử lý', count: this.summary()?.attention ?? 0 },
    { key: 'payment', label: 'Lỗi thanh toán' },
    { key: 'cancelled', label: 'Đã hủy', count: this.cancelledCount() },
    { key: 'logs', label: 'Nhật ký' },
  ]);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.count() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.count(), this.page(), this.pageSize, 'đơn hàng'));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));
  readonly attentionCount = computed(() => this.summary()?.attention ?? 0);
  readonly cancelledCount = computed(() => this.summary()?.by_status.find((row) => row.status === 'cancelled')?.count ?? 0);
  readonly statusOptions = computed(() => this.summary()?.by_status ?? Object.entries(ORDER_STATUS_LABELS).map(([status, label]) => ({ status, label, count: 0 })));
  readonly callResults = CALL_RESULTS;
  readonly cancelReasons = CANCEL_REASONS;
  readonly carrierOutcomes = CARRIER_OUTCOMES;
  readonly activeAction = computed(() => {
    const modal = this.modal();
    return modal?.kind === 'action' ? modal.action : null;
  });
  readonly selectedPayment = computed(() => {
    const order = this.selected();
    return order ? this.paymentOf(order) : null;
  });
  readonly selectedItems = computed(() => this.selected()?.items || []);
  /** One trail per order: state-machine events, the audit rows that name the actor, return records. */
  readonly trace = computed(() =>
    mergeOrderTrace(
      eventTrace(this.selected()?.events || []),
      returnTrace(this.linkedReturns()),
      auditTrace(this.audit()),
    ),
  );
  /** Values the action form can already know from the order, so nothing is typed twice. */
  readonly prefill = computed(() => actionPrefill(this.activeAction(), this.selected()));
  /** Related records reachable without leaving the drawer. */
  readonly orderLinks = computed(() => {
    const order = this.selected();
    if (!order) return [];
    const links = [logsForOrderLink(order.order_id)];
    if (this.canReadReturns()) links.push(returnsForOrderLink(order.order_id));
    const phone = String(order.shipping_phone || '');
    if (phone) links.push({ label: 'Đơn khác của khách này', commands: ['/orders'], query: { q: phone } });
    return links;
  });
  readonly primaryActions = computed(() => (this.selected()?.allowed_actions || []).filter((action) => !action.destructive && action.code !== 'call_confirm'));
  readonly destructiveActions = computed(() => (this.selected()?.allowed_actions || []).filter((action) => action.destructive && action.code !== 'call_confirm'));
  readonly hasCallConfirmed = computed(() => {
    const order = this.selected();
    if (!order) return false;
    if (order.has_successful_call_confirm) return true;
    return (order.events || []).some(
      (event) =>
        event.action === 'call_confirm' &&
        event.result === 'success' &&
        (event.payload as Record<string, unknown> | null)?.['call_result'] === 'reached',
    );
  });
  readonly requiresCallConfirmation = computed(() => {
    const order = this.selected();
    return !!order && order.payment_method === 'COD' && order.status === 'pending' && Number(order.total_amount || 0) >= 1_000_000 && !this.hasCallConfirmed();
  });
  readonly pipelineSteps = computed(() => this.buildPipeline(this.selected()));
  readonly canSimulateCarrier = computed(() => this.session.session()?.roleCode === 'super_admin' && !!this.selected()?.can_simulate_carrier);
  /** Mã mẫu cho hộp quét: mang sẵn dữ liệu vận đơn demo của đơn đang mở để quét là điền đủ. */
  readonly scanSample = computed(() => {
    const order = this.selected();
    if (!order) return '';
    const demo = demoShipmentFacts(order);
    return buildShipmentQr({
      orderCode: order.order_code || undefined,
      carrier: demo.carrier,
      trackingCode: demo.trackingCode,
      trackingUrl: demo.trackingUrl,
    });
  });
  readonly scanSampleCaption = computed(() => {
    const order = this.selected();
    return order ? `Mã mẫu demo cho đơn ${order.order_code || order.order_id.slice(0, 8)} — quét để điền ĐVVC, mã vận đơn và URL.` : '';
  });

  readonly orderColumns: readonly AdminTableColumn[] = [
    {
      key: 'order',
      label: 'Đơn hàng',
      value: (row) => {
        const order = row as AdminOrderRow;
        return order.order_code || order.order_id.slice(0, 8);
      },
    },
    {
      key: 'customer',
      label: 'Khách hàng',
      value: (row) => {
        const order = row as AdminOrderRow;
        return order.shipping_name || order.user?.full_name || order.shipping_phone || '—';
      },
    },
    { key: 'total', label: 'Tổng tiền', value: (row) => this.money((row as AdminOrderRow).total_amount), align: 'right', mono: true },
    { key: 'payment', label: 'Thanh toán', value: (row) => this.paymentMethodLabel((row as AdminOrderRow).payment_method, row as AdminOrderRow) },
    {
      key: 'paymentStatus',
      label: 'TT thanh toán',
      value: (row) => (row as AdminOrderRow).payment_status_label || (row as AdminOrderRow).payment_status || '—',
      badge: (row) => {
        const status = (row as AdminOrderRow).payment_status;
        return status ? { label: (row as AdminOrderRow).payment_status_label || status, tone: status === 'paid' ? 'success' : status === 'failed' || status === 'discrepancy' ? 'danger' : 'warning' } : null;
      },
    },
    {
      key: 'status',
      label: 'Trạng thái đơn',
      value: (row) => this.orderLabel(row as AdminOrderRow),
      badge: (row) => ({ label: this.orderLabel(row as AdminOrderRow), tone: this.orderTone((row as AdminOrderRow).status) }),
    },
    { key: 'date', label: 'Ngày đặt', value: (row) => this.dateTime((row as AdminOrderRow).order_date || (row as AdminOrderRow).created_at) },
    {
      key: 'tags',
      label: 'Cờ',
      value: (row) => ((row as AdminOrderRow).tags || []).map((tag) => tag.label).join(', ') || '—',
      badge: (row) => {
        const tags = (row as AdminOrderRow).tags || [];
        if (tags.some((tag) => tag.code === 'PAYMENT_ATTENTION')) return { label: 'Lỗi TT', tone: 'danger' as const };
        if (tags.some((tag) => tag.code === 'CANCEL_REQUESTED')) return { label: 'Xin hủy', tone: 'warning' as const };
        return null;
      },
    },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', value: (row) => this.dateTime((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.auditActor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => (row as AdminAuditRow).action_label || (row as AdminAuditRow).action || '—' },
    { key: 'target', label: 'Đơn', value: (row) => (row as AdminAuditRow).target_label || (row as AdminAuditRow).target_id || '—' },
  ];

  constructor() {
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    this.destroyRef.onDestroy(() => {
      if (this.copiedPhoneTimer) {
        clearTimeout(this.copiedPhoneTimer);
      }
    });
    useWorkspaceRefresh(() => (this.tab() === 'logs' ? this.loadLogs() : this.reload()));
  }

  /**
   * Applies an inbound deep link: the queue tab, the filters another workspace knows about this
   * order, and the order to open.
   */
  private applyDeepLink(params: ParamMap): void {
    const tab = choiceParam(params, 'tab', ORDER_TABS, this.tab()) as OrderTab;
    this.tab.set(tab);
    this.query.set(textParam(params, 'q'));
    this.status.set(textParam(params, 'status'));
    this.paymentMethod.set(textParam(params, 'payment'));
    this.page.set(1);
    this.logsPage.set(1);
    if (tab === 'logs') {
      this.loadLogs();
    } else {
      this.reload();
    }
    const focus = textParam(params, 'focus');
    if (focus) {
      this.openDetail(focus);
    }
  }

  /**
   * Reloads the order list and summary counts.
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
    this.api.listOrders(params).subscribe({
      next: (payload) => {
        this.rows.set(adminListRows(payload));
        this.count.set(adminListCount(payload));
        this.loading.set(false);
        this.hasLoadedOnce.set(true);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không thể tải đơn hàng.'));
        this.rows.set([]);
        this.count.set(0);
        this.loading.set(false);
      },
    });
    this.api.orderSummary().pipe(catchError(() => of(null))).subscribe((summary) => this.summary.set(summary));
  }

  /**
   * Loads order audit rows.
   */
  loadLogs(): void {
    this.loading.set(true);
    this.api.listAuditLogs({ module: 'orders', limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký đơn hàng.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Switches order tabs.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!ORDER_TABS.includes(tab as (typeof ORDER_TABS)[number])) return;
    this.tab.set(tab as OrderTab);
    this.page.set(1);
    this.closeDetail();
    if (tab === 'logs') {
      this.loadLogs();
      return;
    }
    this.reload();
  }

  /**
   * Applies order filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears order filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.status.set('');
    this.paymentMethod.set('');
    this.from.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves order paging.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Moves log paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.max(1, page));
    this.loadLogs();
  }

  /**
   * Opens an order detail or the COD call flow for pending COD orders.
   */
  openRow(row: unknown): void {
    const order = row as AdminOrderRow;
    if (this.isPendingCod(order) && this.hasAction(order, 'call_confirm')) {
      this.openCodCall(order);
      return;
    }
    this.openDetail(order.order_id);
  }

  /**
   * Whether one order currently exposes a state-machine action.
   */
  hasAction(order: AdminOrderRow, code: string): boolean {
    return Boolean(order.allowed_actions?.some((action) => action.code === code));
  }

  /**
   * Loads a fresh order and its audit rows.
   */
  openDetail(orderId: string): void {
    const requestId = ++this.detailRequestId;
    this.notice.set(null);
    this.detailLoading.set(true);
    this.linkedReturns.set([]);
    this.api.getOrder(orderId).subscribe({
      next: (order) => {
        if (requestId !== this.detailRequestId) return;
        this.selected.set(order);
        this.detailLoading.set(false);
        this.loadOrderAudit(orderId);
        this.loadLinkedReturns(orderId);
      },
      error: (error: unknown) => {
        if (requestId !== this.detailRequestId) return;
        this.detailLoading.set(false);
        this.loadError.set(adminErrorMessage(error));
      },
    });
  }

  /**
   * Closes the detail drawer and modal.
   */
  closeDetail(): void {
    this.detailRequestId += 1;
    this.selected.set(null);
    this.linkedReturns.set([]);
    this.detailLoading.set(false);
    this.closeModal();
    this.notice.set(null);
  }

  /**
   * Opens a generic state-machine action modal.
   */
  openAction(action: AdminOrderAction): void {
    if (!this.canMutate()) return;
    // Recording a call must always pass the COD call flow (explicit start + result),
    // never the generic note form with a preselected "reached".
    if (action.code === 'call_confirm') {
      const order = this.selected();
      if (order) this.openCodCall(order);
      return;
    }
    if (action.code === 'confirm_cod' && this.requiresCallConfirmation()) {
      this.notice.set('Đơn COD từ 1.000.000đ cần ghi nhận cuộc gọi xác nhận thành công trước khi duyệt.');
      return;
    }
    this.modal.set({ kind: 'action', action });
    this.actionError.set(null);
    this.scanOpen.set(false);
    this.scanError.set(null);
    this.scanNotice.set(null);
    // `prefill` đọc từ modal vừa mở, nên phải khởi tạo sau khi modal được set.
    this.shipment.set({
      carrier: this.prefill().carrier,
      trackingCode: this.prefill().trackingCode,
      trackingUrl: this.prefill().trackingUrl,
    });
    this.shipmentUrlEdited.set(false);
  }

  /**
   * Opens payment reconciliation.
   */
  openPaymentResolve(): void {
    this.modal.set({ kind: 'payment' });
    this.actionError.set(null);
  }

  /**
   * Opens the COD call confirmation flow.
   */
  openCodCall(order: AdminOrderRow): void {
    if (!order.allowed_actions?.some((action) => action.code === 'call_confirm')) return;
    this.selected.set(order);
    this.detailLoading.set(true);
    this.actionError.set(null);
    this.copiedPhone.set(false);
    this.codDecision.set('');
    this.codCancelReason.set('customer_request');
    this.codNote.set('');
    this.codCallStarted.set(false);
    this.modal.set({ kind: 'cod_call', order });
    this.api.getOrder(order.order_id).subscribe({
      next: (fresh) => {
        this.selected.set(fresh);
        this.detailLoading.set(false);
        this.modal.set({ kind: 'cod_call', order: fresh });
      },
      error: (error: unknown) => {
        this.detailLoading.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không đọc được trạng thái mới nhất.'));
      },
    });
  }

  /**
   * Closes the active modal.
   */
  closeModal(): void {
    this.modal.set(null);
    this.actionError.set(null);
    this.submitting.set(false);
    this.copiedPhone.set(false);
    this.scanOpen.set(false);
    this.scanError.set(null);
    this.scanNotice.set(null);
  }

  /**
   * Copies the recipient phone. The confirmation resets after two seconds; failures are reported
   * instead of silently leaving the button in its old label.
   */
  copyPhone(phone: string | undefined): void {
    if (!phone) return;
    if (!navigator.clipboard) {
      this.actionError.set('Trình duyệt không cho phép sao chép tự động. Chọn số điện thoại và sao chép thủ công.');
      return;
    }
    void navigator.clipboard
      .writeText(phone)
      .then(() => {
        this.actionError.set(null);
        this.copiedPhone.set(true);
        if (this.copiedPhoneTimer) {
          clearTimeout(this.copiedPhoneTimer);
        }
        this.copiedPhoneTimer = setTimeout(() => this.copiedPhone.set(false), 2000);
      })
      .catch(() => {
        this.actionError.set('Không sao chép được số điện thoại. Chọn số và sao chép thủ công.');
      });
  }

  /**
   * Applies a quick call note.
   */
  setCodQuickNote(note: string): void {
    this.codNote.set(note);
  }

  /**
   * Unlocks outcome entry after the operator starts the call.
   */
  startCodCall(): void {
    if (this.detailLoading() || this.submitting() || !this.selected()?.shipping_phone) return;
    this.codCallStarted.set(true);
    this.actionError.set(null);
  }

  /**
   * Submits the COD call outcome.
   */
  /**
   * Saves the call result, and — with `confirmOrder` — confirms the same COD order in one step.
   *
   * `call_confirm` is status-neutral by design; `confirm_cod` is the guarded transition. When
   * the customer already agreed on the phone the operator should not have to click a second
   * button and re-enter the same note, so the second action reuses the note and the version the
   * first response returned. Online-paid orders never take this path (COD only).
   */
  submitCodCall(event: Event, confirmOrder = false): void {
    event.preventDefault();
    const order = this.selected();
    if (!order || this.submitting() || this.detailLoading()) return;
    if (!this.codCallStarted()) {
      this.actionError.set('Bấm Gọi để bắt đầu liên hệ, rồi ghi nhận kết quả thực tế.');
      return;
    }
    const note = this.codNote().trim();
    if (note.length < 5) {
      this.actionError.set('Vui lòng nhập ghi chú cuộc gọi (tối thiểu 5 ký tự).');
      return;
    }
    const decision = this.codDecision();
    if (!decision) {
      this.actionError.set('Chọn kết quả liên hệ thực tế trước khi lưu.');
      return;
    }
    let actionCode = 'call_confirm';
    const body: Record<string, unknown> = { note };
    if (decision === 'confirm') {
      body['callResult'] = 'reached';
    } else if (decision === 'cancel') {
      actionCode = 'cancel';
      body['cancelReason'] = this.codCancelReason();
    } else if (decision === 'no_answer') {
      body['callResult'] = 'no_answer';
    } else {
      actionCode = 'cancel';
      body['cancelReason'] = 'suspected_fraud';
    }
    if (!order.allowed_actions?.some((action) => action.code === actionCode)) {
      this.actionError.set('Thao tác không còn được phép. Mở lại đơn để kiểm tra.');
      return;
    }
    this.submitting.set(true);
    this.api.performOrderAction(order.order_id, actionCode, { ...body, expectedVersion: order.version }).subscribe({
      next: (result) => {
        const canConfirm =
          confirmOrder &&
          decision === 'confirm' &&
          result.order.payment_method === 'COD' &&
          !!result.order.allowed_actions?.some((action) => action.code === 'confirm_cod');
        if (!canConfirm) {
          this.applyResult(result);
          if (confirmOrder && decision === 'confirm') {
            this.notice.set('Đã lưu kết quả cuộc gọi. Đơn không còn ở trạng thái cần xác nhận nên hệ thống không xác nhận lại.');
          }
          return;
        }
        this.api
          .performOrderAction(result.order.order_id, 'confirm_cod', { note, expectedVersion: result.order.version })
          .subscribe({
            next: (confirmed) => {
              this.applyResult(confirmed);
              this.notice.set('Đã lưu cuộc gọi và xác nhận đơn trong cùng một bước.');
            },
            error: (error: unknown) => {
              this.applyResult(result);
              this.notice.set(
                `Đã lưu kết quả cuộc gọi, nhưng xác nhận đơn chưa thành công: ${adminErrorMessage(error)} Bấm "Xác nhận đơn" để đi tiếp.`,
              );
            },
          });
      },
      error: (error: unknown) => this.handleActionError(order.order_id, error),
    });
  }

  /**
   * Submits a generic order action.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const order = this.selected();
    const action = this.activeAction();
    if (!order || !action || this.submitting()) return;
    if (action.code === 'confirm_cod' && this.requiresCallConfirmation()) {
      this.actionError.set('Đơn COD từ 1.000.000đ bắt buộc ghi nhận cuộc gọi xác nhận thành công trước khi duyệt.');
      return;
    }
    const body = this.actionBody(action, event.target as HTMLFormElement);
    if (action.requires_note && String(body['note'] || '').length < 5) {
      this.actionError.set('Cần nhập ghi chú (tối thiểu 5 ký tự).');
      return;
    }
    this.submitting.set(true);
    this.runAction(action, order, body);
  }

  /**
   * Stores one action result in the drawer and refreshes the list.
   */
  private applyResult(result: AdminOrderActionResult): void {
    this.submitting.set(false);
    this.closeModal();
    this.selected.set(result.order);
    this.notice.set(this.refundNotice(result.refund));
    this.loadOrderAudit(result.order.order_id);
    this.loadLinkedReturns(result.order.order_id);
    this.reload();
  }

  /**
   * Runs one state-machine action, then chains the handover the API keeps as a separate step.
   *
   * `upsert_shipment` is status-neutral by design (migration 038), so shipping is only reached
   * by a second `confirm_handover` call. Saving a tracking code means the parcel is with the
   * carrier, so the handover always follows in the same flow; only its failure is reported.
   */
  private runAction(action: AdminOrderAction, order: AdminOrderRow, body: Record<string, string>, chained = false): void {
    this.api.performOrderAction(order.order_id, action.code, { ...body, expectedVersion: order.version }).subscribe({
      next: (result) => {
        this.applyResult(result);
        const facts = { carrier: String(body['carrier'] || ''), trackingCode: String(body['trackingCode'] || '') };
        const code = result.order.order_code || result.order.order_id.slice(0, 8);
        if (chained) {
          this.notice.set(`Vận đơn ${facts.trackingCode} đã lưu và hàng đã bàn giao cho ${result.order.carrier || facts.carrier || 'đơn vị vận chuyển'} (đơn ${code}).`);
          return;
        }
        if (action.code !== 'upsert_shipment') return;
        const followUp = handoverFollowUp(result.order, facts);
        if (!followUp) return;
        this.submitting.set(true);
        this.runAction(followUp, result.order, { note: handoverNote(facts.carrier, facts.trackingCode, code) }, true);
      },
      error: (error: unknown) => {
        if (!chained) {
          this.handleActionError(order.order_id, error);
          return;
        }
        this.submitting.set(false);
        this.notice.set(
          `Vận đơn đã lưu, nhưng bàn giao chưa thành công: ${adminErrorMessage(error)} Mã vận đơn đã được điền sẵn — bấm "Xác nhận bàn giao ĐVVC" để đi tiếp.`,
        );
      },
    });
  }

  /**
   * Edits one shipment field. Changing the carrier or tracking code re-derives the tracking URL
   * unless the operator already typed one by hand.
   */
  onShipmentField(field: 'carrier' | 'trackingCode' | 'trackingUrl', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.shipment.update((current) => ({ ...current, [field]: value }));
    if (field === 'trackingUrl') {
      this.shipmentUrlEdited.set(true);
      return;
    }
    if (this.shipmentUrlEdited()) return;
    const next = this.shipment();
    const derived = deriveTrackingUrl(next.carrier, next.trackingCode);
    if (derived) this.shipment.update((current) => ({ ...current, trackingUrl: derived }));
  }

  /**
   * Fills the shipment from a scanned code. A carrier label that only carries the tracking
   * number fills that field; the order's own QR fills the demo shipment for that order; a label
   * for another order is refused instead of silently applied.
   */
  applyShipmentScan(text: string): void {
    this.scanOpen.set(false);
    this.scanNotice.set(null);
    const order = this.selected();
    const result = parseScan(text, { orderId: order?.order_id, orderCode: order?.order_code });
    if (result.mismatch) {
      this.scanError.set('Mã QR này thuộc một đơn khác. Kiểm lại label trước khi lưu vận đơn.');
      return;
    }
    if (result.kind === 'order' && order) {
      const demo = demoShipmentFacts(order);
      this.shipment.set(demo);
      this.shipmentUrlEdited.set(true);
      this.scanError.set(null);
      this.scanNotice.set(`Mã QR khớp đơn ${order.order_code || ''}: đã điền vận đơn demo ${demo.carrier} · ${demo.trackingCode}.`);
      return;
    }
    if (result.kind !== 'tracking' && result.kind !== 'shipment') {
      this.scanError.set('Không đọc được thông tin vận đơn trong mã này.');
      return;
    }
    this.shipment.update((current) => ({
      carrier: result.carrier ? carrierLabel(result.carrier) : current.carrier,
      trackingCode: result.trackingCode || current.trackingCode,
      trackingUrl: result.trackingUrl || current.trackingUrl,
    }));
    if (result.trackingUrl) this.shipmentUrlEdited.set(true);
    if (!this.shipmentUrlEdited()) {
      const next = this.shipment();
      const derived = deriveTrackingUrl(next.carrier, next.trackingCode);
      if (derived) this.shipment.update((current) => ({ ...current, trackingUrl: derived }));
    }
    this.scanError.set(null);
    const filled = this.shipment();
    this.scanNotice.set(`Đã điền từ mã QR: ${filled.carrier || 'ĐVVC'} · ${filled.trackingCode}.`);
  }

  /** Link in trên label của đơn; quét bằng điện thoại sẽ mở thẳng đơn này. */
  orderQr(order: AdminOrderRow): string {
    return buildOrderQrLink(typeof window !== 'undefined' ? window.location.origin : '', order.order_id, order.order_code);
  }

  /**
   * Resolves a payment manually.
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
        decision: this.field(form, 'decision').value,
        reason: this.field(form, 'reason').value.trim(),
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
   * Simulates a carrier outcome for super-admin verification.
   */
  simulateCarrier(outcome: string): void {
    const order = this.selected();
    if (!order || this.submitting()) return;
    this.submitting.set(true);
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

  /**
   * Exports the current page of orders.
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
    const csv = rows.map((row) => row.map((value) => this.csvCell(value)).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `velura-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /**
   * Quotes a CSV cell and neutralises spreadsheet formula prefixes from customer data.
   */
  private csvCell(value: unknown): string {
    const text = String(value ?? '');
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  /**
   * Whether an order is a pending COD order.
   */
  isPendingCod(order: AdminOrderRow | null | undefined): boolean {
    return !!order && order.payment_method === 'COD' && order.status === 'pending';
  }

  /**
   * Whether a payment-attention tag exists.
   */
  isPaymentError(order: AdminOrderRow): boolean {
    return (order.tags || []).some((tag) => tag.code === 'PAYMENT_ATTENTION');
  }

  /**
   * Latest payment row.
   */
  paymentOf(order: AdminOrderRow): AdminOrderPayment | null {
    const payments = Array.isArray(order.payments) ? order.payments : [];
    return [...payments].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] ?? null;
  }

  /**
   * Order status label.
   */
  orderLabel(order: AdminOrderRow | null | undefined): string {
    return order?.status_label || statusLabelFrom(ORDER_STATUS_LABELS, order?.status);
  }

  /**
   * Order status tone.
   */
  orderTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
    if (status === 'delivered') return 'success';
    if (status === 'cancelled' || status === 'delivery_failed') return 'danger';
    if (status === 'pending' || status === 'waiting_payment' || status === 'processing') return 'warning';
    if (status === 'confirmed' || status === 'shipping') return 'info';
    return 'neutral';
  }

  /**
   * Payment method label including provider hints.
   */
  paymentMethodLabel(method: string | undefined, order?: AdminOrderRow | null): string {
    const target = order ?? this.selected();
    const payments = Array.isArray(target?.payments) ? target!.payments : [];
    const provider = String(payments[0]?.payment_provider || payments[0]?.payment_method || '').toLowerCase();
    const note = String(target?.internal_note || '');
    if (provider === 'vnpay' || note.includes('VNPay')) return 'VNPay (VietQR)';
    if (provider === 'momo' || note.includes('MoMo')) return 'MoMo (VietQR)';
    if (provider === 'stripe' || note.includes('Stripe')) return 'Online (Stripe)';
    if (method === 'COD') return 'COD';
    if (method === 'ONLINE_PAYMENT') return 'Online Payment';
    return method || '—';
  }

  /**
   * Whether an action exposes a form field.
   */
  hasField(action: AdminOrderAction | null, field: string): boolean {
    return !!action && action.fields.includes(field as AdminOrderAction['fields'][number]);
  }

  /**
   * Money formatter.
   */
  money(value: number | undefined | null): string {
    return adminMoney(value);
  }

  /**
   * Line total.
   */
  lineTotal(unitPrice: number | undefined, quantity: number | undefined): string {
    return adminMoney(Number(unitPrice || 0) * Number(quantity || 0));
  }

  /**
   * Timestamp formatter.
   */
  dateTime(value: string | undefined | null): string {
    return adminDateTime(value);
  }

  /**
   * Audit actor.
   */
  auditActor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  /**
   * Which record wrote a trail row.
   */
  originLabel(origin: OrderTraceOrigin): string {
    if (origin === 'return') return 'Đổi trả';
    if (origin === 'audit') return 'Kiểm tra';
    return 'Đơn';
  }

  /**
   * Updates the order query.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the status filter.
   */
  onStatusChange(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the payment method filter.
   */
  onPaymentMethodChange(event: Event): void {
    this.paymentMethod.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the from-date filter.
   */
  onFromChange(event: Event): void {
    this.from.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the COD decision.
   */
  onCodDecision(event: Event): void {
    this.codDecision.set((event.target as HTMLSelectElement).value as 'confirm' | 'cancel' | 'no_answer' | 'invalid');
  }

  /**
   * Updates the COD cancel reason.
   */
  onCodCancelReason(event: Event): void {
    this.codCancelReason.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the COD note.
   */
  onCodNote(event: Event): void {
    this.codNote.set((event.target as HTMLTextAreaElement).value);
  }

  private loadOrderAudit(orderId: string): void {
    this.api.orderAuditLogs(orderId, { limit: '10' }).subscribe({
      next: (payload) => {
        if (this.selected()?.order_id === orderId) this.audit.set(adminListRows(payload));
      },
      error: () => {
        if (this.selected()?.order_id === orderId) this.audit.set([]);
      },
    });
  }

  /**
   * Loads the return records hanging off this order so refunds and exchanges join the trail.
   */
  private loadLinkedReturns(orderId: string): void {
    if (!this.canReadReturns()) {
      this.linkedReturns.set([]);
      return;
    }
    this.api
      .listReturns({ order_id: orderId, limit: '10' })
      .pipe(catchError(() => of(null)))
      .subscribe((payload) => {
        if (this.selected()?.order_id === orderId) {
          this.linkedReturns.set(payload ? adminListRows(payload) : []);
        }
      });
  }

  private handleActionError(orderId: string, error: unknown): void {
    this.submitting.set(false);
    const message = adminErrorMessage(error);
    if (STALE_ORDER_CODES.has(this.errorCode(error))) {
      this.closeModal();
      this.openDetail(orderId);
      this.reload();
      this.notice.set(`${message} Màn hình đã tải lại trạng thái mới nhất.`);
      return;
    }
    this.actionError.set(message);
  }

  private errorCode(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) return '';
    const payload = error.error as { error?: { code?: string } | string } | null;
    return typeof payload?.error === 'object' ? payload.error?.code || '' : '';
  }

  private refundNotice(refund: AdminOrderActionResult['refund']): string | null {
    if (!refund) return null;
    if (refund.status === 'refunded') return 'Đã hoàn tiền cho khách qua Stripe.';
    if (refund.status === 'requested') return 'Đã gửi yêu cầu hoàn tiền tới Stripe, chờ Stripe xác nhận.';
    if (refund.status === 'failed') return `Hoàn tiền chưa thành công: ${refund.message || 'Stripe từ chối'}.`;
    return null;
  }

  private actionBody(action: AdminOrderAction, form: HTMLFormElement): Record<string, string> {
    const value = (name: string) => this.field(form, name).value.trim();
    const body: Record<string, string> = { note: value('note') };
    if (action.fields.includes('call_result')) body['callResult'] = value('callResult');
    if (action.fields.includes('shortage')) body['shortage'] = value('shortage');
    if (action.fields.includes('shipment') || action.fields.includes('tracking')) {
      const shipment = this.shipment();
      body['trackingCode'] = shipment.trackingCode.trim();
      body['trackingUrl'] = shipment.trackingUrl.trim();
      body['carrier'] = shipment.carrier.trim();
    }
    if (action.fields.includes('cancel_reason')) body['cancelReason'] = value('cancelReason');
    return body;
  }

  private field(form: HTMLFormElement, name: string): HTMLInputElement {
    return (form.elements.namedItem(name) as HTMLInputElement | null) ?? document.createElement('input');
  }

  private buildPipeline(order: AdminOrderRow | null): Array<{ id: string; label: string; state: string }> {
    if (!order) return [];
    const isOnline = order.payment_method === 'ONLINE_PAYMENT' || order.payment_method === 'STRIPE';
    const base = [
      { id: 'pending', label: isOnline ? '1. Chờ thanh toán' : '1. Chờ xác nhận' },
      { id: 'confirmed', label: '2. Đã xác nhận' },
      { id: 'processing', label: '3. Chuẩn bị hàng' },
      { id: 'shipping', label: '4. Đang giao hàng' },
      { id: 'delivered', label: '5. Giao thành công' },
    ];
    if (order.status === 'cancelled') {
      const events = order.events || [];
      let index = 0;
      if (events.some((event) => event.action === 'confirm_handover' || event.action === 'carrier_failed_retrying')) index = 3;
      else if (events.some((event) => event.action === 'start_processing' || event.action === 'upsert_shipment')) index = 2;
      else if (events.some((event) => event.action === 'confirm_cod' || event.action === 'payment_succeeded')) index = 1;
      return [...base.slice(0, index).map((step) => ({ ...step, state: 'done' })), { id: 'cancelled', label: 'Đã hủy', state: 'cancelled' }];
    }
    if (order.status === 'delivery_failed') {
      return [...base.slice(0, 4).map((step) => ({ ...step, state: 'done' })), { id: 'delivery_failed', label: 'Giao thất bại', state: 'delivery_failed' }];
    }
    const current =
      order.status === 'confirmed' ? 1 : order.status === 'processing' ? 2 : order.status === 'shipping' ? 3 : order.status === 'delivered' ? 4 : 0;
    return base.map((step, index) => ({ ...step, state: index < current ? 'done' : index === current ? 'current' : 'upcoming' }));
  }
}
