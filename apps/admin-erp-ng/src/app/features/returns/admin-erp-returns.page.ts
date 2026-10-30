import { Subscription, catchError, forkJoin, of } from 'rxjs';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, RouterLink, type ParamMap } from '@angular/router';
import { toDataURL } from 'qrcode';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminOrderRow,
  AdminReturnRow,
  AdminReturnLine,
  AdminTicketRow,
} from '../../core/admin-erp-api.service';
import { orderFocusLink, returnFocusLink, type OrderTraceLink } from '../../core/admin-erp-order-trace';
import { choiceParam, textParam, watchQueryParams } from '../../core/admin-erp-deep-link';
import { buildReturnQrLink, buildReturnQrPayload, parseScan } from '../../core/admin-erp-qr';
import {
  MIN_NOTE_LENGTH,
  REFUND_FLOW_LABELS,
  REFUND_RECEIVER_STATUS_LABELS,
  RETURN_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  canTicketAction,
  contactAllowed,
  isChatGovernedTicket,
  isReturnOpen,
  paymentKindLabel,
  refundInfoAllowed,
  returnStatusLabel,
  returnStatusTone,
  returnDecisionLabel,
  returnItemActions,
  itemRefundAllowed,
  returnContactOverdue,
} from '../../core/admin-erp-service-desk';
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
import { AdminTone, TICKET_STATUS_LABELS } from '../../core/admin-erp-status-labels';
import { ChatDeskComponent } from './chat-desk.component';
import { ReturnFlowComponent, ReturnFlowKind, RETURN_ITEM_ACTION_LABELS } from './return-flow.component';

type DeskTab = 'returns' | 'tickets' | 'chat' | 'logs';
type TicketAction = 'reply' | 'resolve' | 'close';

const DESK_TABS: readonly string[] = ['returns', 'tickets', 'chat', 'logs'];
const RETURN_STATUS_VALUES: readonly string[] = Object.keys(RETURN_STATUS_LABELS);

const EMPTY_RETURNS = { rows: [] as AdminReturnRow[], count: 0 };
const EMPTY_TICKETS = { rows: [] as AdminTicketRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

/**
 * Returns and CSKH workspace: the refund queue with its warehouse and payment steps, the
 * support-ticket queue, the live-chat desk and the return audit trail. Every write goes
 * through the return API with `expectedVersion`, and the buttons only appear for steps the
 * server state machine actually allows.
 */
@Component({
  selector: 'app-admin-erp-returns-page',
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
    ReturnFlowComponent,
    ChatDeskComponent,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-returns.page.html',
  styleUrl: './admin-erp-returns.page.scss',
})
export class AdminErpReturnsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private listRequest = new Subscription();
  private detailRequestId = 0;

  readonly tab = signal<DeskTab>('returns');
  readonly returns = signal<AdminReturnRow[]>([]);
  readonly tickets = signal<AdminTicketRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly total = signal(0);
  readonly ticketsTotal = signal(0);
  readonly logsTotal = signal(0);
  readonly page = signal(1);
  readonly ticketsPage = signal(1);
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  readonly statusFilter = signal('');
  readonly paymentFilter = signal<'' | 'cod' | 'online'>('');
  readonly search = signal('');
  readonly orderFilter = signal('');
  readonly ticketStatus = signal('');
  readonly ticketSearch = signal('');
  readonly logTarget = signal('');

  readonly openReturns = signal(0);
  readonly pendingReturns = signal(0);
  readonly awaitingReceipt = signal(0);
  readonly openTickets = signal(0);
  readonly processingTickets = signal(0);

  readonly selected = signal<AdminReturnRow | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly flow = signal<ReturnFlowKind>(null);
  readonly gatewayNote = signal<string | null>(null);
  readonly flowLine = signal<AdminReturnLine | null>(null);
  readonly scanOpen = signal(false);
  readonly scanError = signal<string | null>(null);

  readonly selectedTicket = signal<AdminTicketRow | null>(null);
  readonly ticketAction = signal<TicketAction | null>(null);
  readonly ticketError = signal<string | null>(null);
  readonly ticketBusy = signal(false);
  /** Chat case a deep link asked to open; the desk reads it and loads that transcript. */
  readonly chatFocus = signal('');
  /** Who did what on the open return, read from the service audit trail. */
  readonly recordTrail = signal<AdminAuditRow[]>([]);
  readonly ticketLinks = computed(() => {
    const ticket = this.selectedTicket();
    const links: OrderTraceLink[] = [];
    if (!ticket) {
      return links;
    }
    const phone = String(ticket.guest_phone || '');
    if (phone) {
      links.push({ label: 'Đơn của số điện thoại này', commands: ['/orders'], query: { q: phone } });
      links.push({ label: 'Khiếu nại khác cùng số', commands: ['/returns'], query: { tab: 'tickets', q: phone } });
    }
    if (ticket.chat_session_id) {
      links.push({ label: 'Hội thoại của phiếu', commands: ['/returns'], query: { tab: 'chat', focus: ticket.chat_session_id } });
    }
    return links;
  });

  readonly selectedLog = signal<AdminAuditRow | null>(null);

  readonly canRead = computed(() => this.session.can('read', 'returns'));
  readonly canWrite = computed(() => this.session.can('update', 'returns'));
  /** Operational writes are reserved for CSKH and super-admin, not order-reader grants. */
  readonly canOperate = computed(() => this.canWrite() && ['super_admin', 'admin_operator_cskh_dt'].includes(this.session.session()?.roleCode || ''));
  /** Final decisions require the explicit super-admin role, not broad update/approve grants. */
  readonly canApprove = computed(() => this.session.session()?.roleCode === 'super_admin' && this.canOperate());
  /** Private receiving-bank details use the same financial-role restriction as the API. */
  readonly canFinance = computed(() => this.canOperate());
  readonly canReadOrders = computed(() => this.session.can('read', 'orders'));
  /**
   * The source order of the open return, so CSKH reads address, items and tracking once instead
   * of switching workspaces and re-typing them into a flow.
   */
  readonly orderContext = signal<AdminOrderRow | null>(null);
  readonly returnLinks = computed(() => {
    const record = this.selected();
    const links: { label: string; commands: readonly string[]; query: Readonly<Record<string, string>> }[] = [];
    if (record?.order_id) links.push(orderFocusLink(record.order_id, 'Đơn hàng gốc'));
    if (record?.exchange_order_id) links.push(orderFocusLink(record.exchange_order_id, 'Đơn đổi'));
    return links;
  });
  readonly minNote = MIN_NOTE_LENGTH;

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'returns', label: 'Đổi trả', count: this.total() },
    { key: 'tickets', label: 'Phiếu hỗ trợ', count: this.ticketsTotal() },
    { key: 'chat', label: 'Hội thoại' },
    { key: 'logs', label: 'Nhật ký đổi trả', count: this.logsTotal() },
  ]);

  readonly statusOptions = [
    { value: '', label: 'Mọi trạng thái' },
    ...Object.entries(RETURN_STATUS_LABELS).map(([value, label]) => ({ value, label })),
  ];
  readonly ticketStatusOptions = [
    { value: '', label: 'Mọi trạng thái' },
    ...Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => ({ value, label })),
  ];
  readonly paymentOptions = [
    { value: '', label: 'Mọi kênh tiền' },
    { value: 'cod', label: 'COD' },
    { value: 'online', label: 'Thanh toán online' },
  ];

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly ticketsPageCount = computed(() => Math.max(1, Math.ceil(this.ticketsTotal() / this.pageSize)));
  readonly logsPageCount = computed(() => Math.max(1, Math.ceil(this.logsTotal() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'phiếu'));
  readonly ticketRangeLabel = computed(() =>
    adminRangeLabel(this.ticketsTotal(), this.ticketsPage(), this.pageSize, 'phiếu'),
  );
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsTotal(), this.logsPage(), this.pageSize, 'nhật ký'));


  readonly columns = computed<readonly AdminTableColumn[]>(() => [
    {
      key: 'return',
      label: 'Phiếu',
      width: '14%',
      value: (row) => (row as AdminReturnRow).return_id.slice(0, 8),
      mono: true,
    },
    {
      key: 'order',
      label: 'Đơn hàng',
      value: (row) => (row as AdminReturnRow).order_code || (row as AdminReturnRow).order_id?.slice(0, 8) || '—',
    },
    {
      key: 'customer',
      label: 'Khách',
      value: (row) => {
        const record = row as AdminReturnRow;
        return [record.customer_name, record.customer_phone].filter(Boolean).join(' · ') || '—';
      },
    },
    {
      key: 'type',
      label: 'Yêu cầu',
      value: (row) => typeLabel((row as AdminReturnRow).return_type),
      badge: (row) => {
        const record = row as AdminReturnRow;
        return record.return_type === 'exchange'
          ? { label: 'Đổi hàng', tone: 'info' as const }
          : { label: 'Hoàn tiền', tone: 'neutral' as const };
      },
    },
    {
      key: 'channel',
      label: 'Kênh tiền',
      value: (row) => paymentKindLabel((row as AdminReturnRow).payment_kind),
    },
    {
      key: 'amount',
      label: 'Hoàn',
      align: 'right',
      mono: true,
      value: (row) => this.money((row as AdminReturnRow).refund_amount),
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => returnStatusLabel((row as AdminReturnRow).status),
      badge: (row) => ({
        label: returnStatusLabel((row as AdminReturnRow).status),
        tone: returnStatusTone((row as AdminReturnRow).status),
      }),
    },
    { key: 'created', label: 'Tạo lúc', value: (row) => this.date((row as AdminReturnRow).created_at) },
  ]);

  readonly ticketColumns = computed<readonly AdminTableColumn[]>(() => [
    {
      key: 'ticket',
      label: 'Phiếu',
      width: '14%',
      value: (row) => (row as AdminTicketRow).title || (row as AdminTicketRow).ticket_id.slice(0, 8),
    },
    {
      key: 'channel',
      label: 'Kênh',
      value: (row) => ((row as AdminTicketRow).chat_session_id ? 'Chat' : 'Trực tiếp'),
      badge: (row) =>
        (row as AdminTicketRow).chat_session_id
          ? { label: 'Chat', tone: 'info' as const }
          : { label: 'Trực tiếp', tone: 'neutral' as const },
    },
    { key: 'contact', label: 'Khách', value: (row) => this.ticketContact(row as AdminTicketRow) },
    {
      key: 'priority',
      label: 'Ưu tiên',
      value: (row) => TICKET_PRIORITY_LABELS[(row as AdminTicketRow).priority || ''] || (row as AdminTicketRow).priority || '—',
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => TICKET_STATUS_LABELS[(row as AdminTicketRow).status || ''] || (row as AdminTicketRow).status || '—',
      badge: (row) => ({
        label: TICKET_STATUS_LABELS[(row as AdminTicketRow).status || ''] || String((row as AdminTicketRow).status || '—'),
        tone: ticketStatusTone((row as AdminTicketRow).status),
      }),
    },
    { key: 'reply', label: 'Phản hồi cuối', width: '26%', value: (row) => (row as AdminTicketRow).admin_reply || '—' },
    { key: 'created', label: 'Tạo lúc', value: (row) => this.date((row as AdminTicketRow).created_at) },
  ]);

  readonly logColumns = computed<readonly AdminTableColumn[]>(() => [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => (row as AdminAuditRow).action_label || (row as AdminAuditRow).action || '—' },
    { key: 'target', label: 'Phiếu', value: (row) => (row as AdminAuditRow).target_label || (row as AdminAuditRow).target_id || '—' },
    { key: 'change', label: 'Thay đổi', width: '28%', value: (row) => (row as AdminAuditRow).change_summary || '—' },
    {
      key: 'result',
      label: 'Kết quả',
      value: (row) => (row as AdminAuditRow).result || 'Thành công',
      badge: (row) => ({ label: (row as AdminAuditRow).result || 'Thành công', tone: 'success' as const }),
    },
  ]);

  constructor() {
    this.destroyRef.onDestroy(() => this.listRequest.unsubscribe());
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Applies an inbound deep link: the queue to show, the order the return list is scoped to and
   * the return to open. Links can arrive while this workspace is already on screen, so every
   * param change is re-applied instead of only the first load.
   */
  private applyDeepLink(params: ParamMap): void {
    this.tab.set(choiceParam(params, 'tab', DESK_TABS, this.tab()) as DeskTab);
    this.orderFilter.set(textParam(params, 'order_id'));
    this.statusFilter.set(choiceParam(params, 'status', RETURN_STATUS_VALUES, this.statusFilter()));
    this.paymentFilter.set(choiceParam(params, 'payment', ['cod', 'online'], this.paymentFilter()) as '' | 'cod' | 'online');
    const search = textParam(params, 'q');
    if (this.tab() === 'tickets') {
      this.ticketSearch.set(search);
    } else {
      this.search.set(search);
    }
    this.page.set(1);
    this.reload();
    const focus = textParam(params, 'focus');
    if (!focus) {
      return;
    }
    if (this.tab() === 'tickets') {
      this.openTicket({ ticket_id: focus } as AdminTicketRow);
    } else if (this.tab() === 'chat') {
      this.chatFocus.set(focus);
    } else {
      this.openReturn({ return_id: focus } as AdminReturnRow);
    }
  }

  /**
   * Loads the active tab.
   */
  reload(): void {
    if (this.tab() === 'tickets') {
      this.loadTickets();
      return;
    }
    if (this.tab() === 'logs') {
      this.loadLogs();
      return;
    }
    if (this.tab() === 'chat') {
      this.loading.set(false);
      return;
    }
    this.loadReturns();
  }

  /**
   * Switches between the four queues.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!DESK_TABS.includes(tab)) {
      return;
    }
    this.tab.set(tab as DeskTab);
    this.closeOverlays();
    this.reload();
  }

  /**
   * Applies the return filters and returns to page 1.
   */
  applyFilters(): void {
    this.page.set(1);
    this.loadReturns();
  }

  /**
   * Clears the return filters.
   */
  resetFilters(): void {
    this.statusFilter.set('');
    this.paymentFilter.set('');
    this.search.set('');
    this.orderFilter.set('');
    this.page.set(1);
    this.loadReturns();
  }

  /**
   * Applies the ticket status filter.
   */
  applyTicketFilters(): void {
    this.ticketsPage.set(1);
    this.loadTickets();
  }

  /**
   * Clears the ticket filter.
   */
  resetTicketFilters(): void {
    this.ticketStatus.set('');
    this.ticketSearch.set('');
    this.ticketsPage.set(1);
    this.loadTickets();
  }

  /**
   * Filters the audit list by return id.
   */
  applyLogFilters(): void {
    this.logsPage.set(1);
    this.loadLogs();
  }

  /**
   * Clears the audit filter.
   */
  resetLogFilters(): void {
    this.logTarget.set('');
    this.logsPage.set(1);
    this.loadLogs();
  }

  /**
   * Moves return paging.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
    this.loadReturns();
  }

  /**
   * Moves ticket paging.
   */
  goTicketsPage(page: number): void {
    this.ticketsPage.set(Math.min(this.ticketsPageCount(), Math.max(1, page)));
    this.loadTickets();
  }

  /**
   * Moves audit paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logsPageCount(), Math.max(1, page)));
    this.loadLogs();
  }

  /**
   * Opens the return drawer and rereads the row, because list rows omit the refund facts.
   */
  openReturn(row: unknown, expectedCode = ''): void {
    const id = (row as AdminReturnRow).return_id;
    const requestId = ++this.detailRequestId;
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.gatewayNote.set(null);
    this.recordTrail.set([]);
    this.api.getReturn(id).subscribe({
      next: (record) => {
        if (requestId !== this.detailRequestId) return;
        this.detailLoading.set(false);
        if (expectedCode && record.return_code && record.return_code !== expectedCode) {
          this.selected.set(null);
          this.scanError.set('Mã QR không khớp với mã phiếu trên hệ thống. Kiểm lại nhãn trước khi nhận hàng.');
          return;
        }
        this.selected.set(record);
        this.loadOrderContext(record.order_id);
        this.loadRecordTrail(record.return_id);
      },
      error: (error: unknown) => {
        if (requestId !== this.detailRequestId) return;
        this.detailLoading.set(false);
        this.selected.set(row as AdminReturnRow);
        this.detailError.set(adminErrorMessage(error, 'Không tải được chi tiết phiếu.'));
        this.loadOrderContext((row as AdminReturnRow).order_id);
        this.loadRecordTrail(id);
      },
    });
  }

  /**
   * Reads the trail of one return: who contacted, approved, rejected or refunded it, with the
   * reason each step stored. Without it the operator hunts the same row in the log queue.
   */
  private loadRecordTrail(returnId: string): void {
    this.api
      .listServiceLogs({ targetId: returnId, limit: '12' })
      .pipe(catchError(() => of(null)))
      .subscribe((payload) => {
        if (this.selected()?.return_id === returnId) {
          this.recordTrail.set(payload ? adminListRows(payload) : []);
        }
      });
  }

  /**
   * Reads the source order of a return. Without the `orders` read capability the drawer keeps
   * the order code only, because the API answers 403 and the operator must not see a fake row.
   */
  private loadOrderContext(orderId: string | undefined): void {
    this.orderContext.set(null);
    if (!orderId || !this.canReadOrders()) {
      return;
    }
    this.api
      .getOrder(orderId)
      .pipe(catchError(() => of(null)))
      .subscribe((order) => {
        if (this.selected()?.order_id === orderId) {
          this.orderContext.set(order);
        }
      });
  }

  /** Opens request contact or one allowed item action; no aggregate progression exists. */
  openFlow(flow: ReturnFlowKind, line: AdminReturnLine | null = null): void {
    if (!this.canOperate() || !flow || this.detailLoading()) return;
    if (flow === 'contact' || flow === 'refund-info') {
      if (!contactAllowed(this.selected())) return;
    } else {
      if (!line?.return_item_id || line.version == null) return;
      if (flow === 'manual' || flow === 'stripe') {
        if (!this.canFinance() || !itemRefundAllowed(line)) return;
      } else if (!returnItemActions(line, this.canApprove()).includes(flow)) return;
    }
    this.flowLine.set(line);
    this.flow.set(flow);
  }

  /** The first non-terminal part drives the quick-action strip; line cards keep their full menus. */
  quickLine(record: AdminReturnRow): AdminReturnLine | null {
    const rank: Record<string, number> = {
      REQUESTED: 0, NEEDS_SUPPORT: 1, RETURN_SHIPPING: 2, WAITING_RETURN: 3,
      RECEIVED: 4, EXCHANGE_PREPARING: 5, EXCHANGE_SHIPPING: 6, REFUND_PENDING: 7,
    };
    return [...(record.lines || [])]
      .filter((line) => !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(String(line.item_status || '')))
      .sort((a, b) => (rank[String(a.item_status)] ?? 90) - (rank[String(b.item_status)] ?? 90))[0] || null;
  }

  /** Terminal requests no longer show the 24h outreach SLA. */
  isTerminal(record: AdminReturnRow): boolean {
    const statuses = (record.lines || []).map((line) => String(line.item_status || ''));
    return statuses.length > 0
      ? statuses.every((status) => ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status))
      : ['COMPLETED', 'REJECTED', 'CANCELLED', 'REFUNDED'].includes(String(record.status || ''));
  }

  /** Actions shown beside this part never derive their resolution from the request type. */
  itemActions(line: AdminReturnLine): readonly Exclude<ReturnFlowKind, null>[] {
    if (!this.canOperate()) return [];
    const actions: Exclude<ReturnFlowKind, null>[] = [...returnItemActions(line, this.canApprove())];
    const record = this.selected();
    if (this.canFinance() && itemRefundAllowed(line)) {
      if (record?.payment_kind === 'stripe') actions.push('stripe');
      if (record?.payment_kind === 'cod' && record.refund_receiver_status === 'valid') actions.push('manual');
    }
    return actions;
  }

  /** Uses the same operator wording in the drawer and confirmation dialog. */
  actionLabel(action: Exclude<ReturnFlowKind, null>): string { return RETURN_ITEM_ACTION_LABELS[action]; }

  /** Decision and progress remain separate when a request is only partially approved. */
  decisionLabel(value: string | null | undefined): string { return returnDecisionLabel(value); }

  /** The server's 24-hour outreach deadline remains visible while waiting for a customer. */
  contactOverdue(record: AdminReturnRow): boolean { return returnContactOverdue(record); }

  /** Reader roles get no unmasked account number even if a stale response includes it. */
  bankAccount(value: string | null | undefined): string {
    return this.canFinance() ? value || '—' : value ? `•••• ${value.slice(-4)}` : '—';
  }

  /** Link in trên phiếu trả; quét bằng điện thoại sẽ mở thẳng phiếu này. */
  returnQr(record: AdminReturnRow): string {
    return buildReturnQrLink(typeof window !== 'undefined' ? window.location.origin : '', record.return_id);
  }

  /**
   * Prints the return slip the customer attaches to the parcel. The QR carries both the return
   * id and the immutable slip code so the carrier/warehouse can cross-check the parcel later.
   */
  async printReturnLabel(record: AdminReturnRow): Promise<void> {
    const shipment = record.shipment || null;
    const qr = await toDataURL(buildReturnQrPayload(record.return_id, record.return_code), {
      width: 640,
      margin: 2,
      errorCorrectionLevel: 'M',
    }).catch(() => '');
    if (!qr) {
      this.detailError.set('Không tạo được mã QR để in phiếu hoàn.');
      return;
    }
    const windowRef = window.open('', '_blank', 'width=560,height=780');
    if (!windowRef) {
      this.detailError.set('Trình duyệt đang chặn cửa sổ in. Cho phép popup rồi thử lại.');
      return;
    }
    const doc = windowRef.document;
    doc.title = `Phiếu gửi hoàn ${record.return_code || record.return_id}`;
    const style = doc.createElement('style');
    style.textContent = `
      body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}
      .slip{border:2px solid #111;border-radius:12px;padding:20px;max-width:440px}
      h1{font-size:18px;margin:0 0 4px} .muted{color:#555;font-size:12px}
      .code{font-family:monospace;font-size:15px;font-weight:700;margin:12px 0 4px}
      .qr{display:block;margin:14px auto;width:240px;height:240px}
      table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
      td{padding:5px 0;vertical-align:top} td:first-child{color:#555;width:38%}
      .note{margin-top:14px;font-size:12px;line-height:1.5}`;
    doc.head.appendChild(style);

    const slip = doc.createElement('section');
    slip.className = 'slip';
    const title = doc.createElement('h1');
    title.textContent = 'PHIẾU GỬI HÀNG HOÀN — VELURA';
    const intro = doc.createElement('div');
    intro.className = 'muted';
    intro.textContent = 'Dán phiếu này lên ngoài kiện hàng trước khi ĐVVC lấy hàng.';
    const code = doc.createElement('div');
    code.className = 'code';
    code.textContent = String(record.return_code || record.return_id);
    const image = doc.createElement('img');
    image.className = 'qr';
    image.src = qr;
    image.alt = 'QR phiếu hoàn';

    const table = doc.createElement('table');
    const addRow = (label: string, value: unknown): void => {
      const row = doc.createElement('tr');
      const key = doc.createElement('td');
      key.textContent = label;
      const cell = doc.createElement('td');
      cell.textContent = String(value ?? '');
      row.append(key, cell);
      table.appendChild(row);
    };
    addRow('Đơn gốc', record.order_code || record.order_id || '—');
    addRow('Khách hàng', [record.customer_name, record.customer_phone].filter(Boolean).join(' · ') || '—');
    addRow('ĐVVC', shipment?.carrier || '—');
    addRow('Mã vận đơn', shipment?.tracking_code || record.tracking_return_code || '—');
    addRow('Người gửi', [record.customer_name, record.customer_phone, record.customer_address].filter(Boolean).join(' · ') || '—');
    addRow('Người nhận', 'Kho Velura — địa chỉ theo hợp đồng ĐVVC');

    const note = doc.createElement('div');
    note.className = 'note';
    note.textContent = 'Kho Velura chỉ nhận hàng khi mã QR và mã phiếu khớp. Khách nên quay video đóng gói; ĐVVC chụp ảnh kiện hàng niêm phong khi lấy hàng.';
    slip.append(title, intro, code, image, table, note);
    doc.body.appendChild(slip);
    windowRef.focus();
    windowRef.setTimeout(() => windowRef.print(), 100);
  }

  /**
   * Opens the return whose QR was scanned at the warehouse door. A code for an order is not
   * enough to receive goods; only a return slip code opens a slip.
   */
  applyReturnScan(text: string): void {
    this.scanOpen.set(false);
    const result = parseScan(text);
    if (result.kind === 'return' && result.returnId) {
      this.scanError.set(null);
      this.openReturn({ return_id: result.returnId } as AdminReturnRow, result.returnCode || '');
      return;
    }
    this.scanError.set('Mã này không phải phiếu đổi trả của Velura. Quét mã trên phiếu hoặc mở danh sách.');
  }

  /**
   * Closes the write flow; the parent reloads the queue with the saved row.
   */
  closeFlow(): void {
    this.flow.set(null);
  }

  /**
   * Rereads the return after a write and keeps the drawer on the fresh version.
   */
  onFlowDone(message = ''): void {
    const id = this.selected()?.return_id;
    this.flow.set(null);
    if (message) {
      this.gatewayNote.set(message);
    }
    if (id) {
      this.openReturn({ return_id: id } as AdminReturnRow);
    }
    this.loadReturns();
  }


  /**
   * Opens a ticket drawer with its stored reply.
   */
  openTicket(row: unknown): void {
    const ticket = row as AdminTicketRow;
    this.selectedTicket.set(ticket);
    this.ticketError.set(null);
    this.api.getTicket(ticket.ticket_id).subscribe({
      next: (fresh) => this.selectedTicket.set(fresh),
      error: () => undefined,
    });
  }

  /**
   * Opens one ticket action.
   */
  openTicketAction(action: TicketAction): void {
    if (!this.canWrite() || !canTicketAction(this.selectedTicket(), action) || isChatGovernedTicket(this.selectedTicket())) {
      return;
    }
    this.ticketError.set(null);
    this.ticketAction.set(action);
  }

  /**
   * Writes the ticket action with the version shown on screen.
   */
  submitTicketAction(event: Event): void {
    event.preventDefault();
    const ticket = this.selectedTicket();
    const action = this.ticketAction();
    if (!ticket || !action || ticket.version == null || this.ticketBusy()) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const note = readField(form, 'note');
    if (action !== 'close' && note.length < (action === 'reply' ? 1 : MIN_NOTE_LENGTH)) {
      this.ticketError.set(
        action === 'reply' ? 'Nội dung phản hồi không được để trống.' : `Ghi chú cần tối thiểu ${MIN_NOTE_LENGTH} ký tự.`,
      );
      return;
    }
    this.ticketBusy.set(true);
    const request =
      action === 'reply'
        ? this.api.respondTicket(ticket.ticket_id, { response: note, expectedVersion: ticket.version })
        : action === 'resolve'
          ? this.api.resolveTicket(ticket.ticket_id, { adminNote: note, expectedVersion: ticket.version })
          : this.api.closeTicket(ticket.ticket_id, { expectedVersion: ticket.version });
    request.subscribe({
      next: (fresh) => {
        this.ticketBusy.set(false);
        this.ticketAction.set(null);
        this.selectedTicket.set(fresh);
        this.loadTickets();
      },
      error: (error: unknown) => {
        this.ticketBusy.set(false);
        this.ticketError.set(adminErrorMessage(error, 'Không cập nhật được phiếu hỗ trợ.'));
      },
    });
  }

  /**
   * Closes the ticket action modal.
   */
  closeTicketAction(): void {
    if (!this.ticketBusy()) {
      this.ticketAction.set(null);
      this.ticketError.set(null);
    }
  }

  /**
   * Opens the audit payload.
   */
  openLog(row: unknown): void {
    this.selectedLog.set(row as AdminAuditRow);
  }

  /**
   * An audit row scoped to a return can open that return, so the operator follows the trail
   * instead of searching the queue by hand.
   */
  logReturnLink(row: AdminAuditRow): OrderTraceLink | null {
    const id = String(row.target_id || '');
    if (row.module !== 'returns' || !id) {
      return null;
    }
    return returnFocusLink(id, 'Mở hồ sơ đổi trả');
  }

  /**
   * Closes the audit payload.
   */
  closeLog(): void {
    this.selectedLog.set(null);
  }

  /**
   * Closes every overlay.
   */
  closeOverlays(): void {
    this.detailRequestId += 1;
    this.selected.set(null);
    this.selectedTicket.set(null);
    this.selectedLog.set(null);
    this.orderContext.set(null);
    this.recordTrail.set([]);
    this.flow.set(null);
    this.ticketAction.set(null);
    this.detailError.set(null);
    this.gatewayNote.set(null);
  }

  /**
   * Drops the order scope a deep link put on the queue.
   */
  clearOrderFilter(): void {
    this.orderFilter.set('');
    this.page.set(1);
    this.loadReturns();
  }

  /**
   * Money label.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Timestamp label.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Vietnamese return status label.
   */
  /** Next operational action across parts; red = needs a human decision/exception, green = done. */
  nextStep(record: AdminReturnRow): string {
    const statuses = (record.lines || []).map((line) => String(line.item_status || ''));
    if (statuses.some((status) => status === 'NEEDS_SUPPORT')) return 'Cần hỗ trợ / xử lý ngoại lệ';
    if (statuses.some((status) => status === 'RETURN_SHIPPING')) return 'Kho nhận và kiểm hàng';
    if (statuses.some((status) => status === 'RECEIVED')) return 'Hoàn tiền hoặc chuẩn bị đơn đổi';
    if (statuses.some((status) => status === 'EXCHANGE_PREPARING')) return 'Giao phần hàng đổi';
    if (statuses.some((status) => status === 'EXCHANGE_SHIPPING')) return 'Theo dõi giao hàng đổi';
    if (statuses.some((status) => status === 'REFUND_PENDING')) return 'Theo dõi hoàn tiền';
    if (statuses.some((status) => status === 'WAITING_RETURN')) return 'Chờ ĐVVC lấy hàng';
    if (statuses.some((status) => status === 'REQUESTED')) return 'Admin duyệt phần hàng';
    return 'Đã kết thúc';
  }

  /** Action tone drives the next-step banner color without inventing a second workflow. */
  nextStepTone(record: AdminReturnRow): 'action' | 'waiting' | 'done' {
    const statuses = (record.lines || []).map((line) => String(line.item_status || ''));
    if (statuses.some((status) => ['REQUESTED', 'NEEDS_SUPPORT', 'RECEIVED', 'EXCHANGE_PREPARING'].includes(status))) return 'action';
    if (statuses.length && statuses.every((status) => ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status))) return 'done';
    return 'waiting';
  }

  statusLabel(status: string | null | undefined): string {
    return returnStatusLabel(status);
  }

  /**
   * Guest contact of a ticket.
   */
  ticketContact(ticket: AdminTicketRow): string {
    return [ticket.guest_phone, ticket.guest_email]
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0)
      .join(' · ') || '—';
  }

  /**
   * Payment channel label.
   */
  paymentLabel(kind: string | null | undefined): string {
    return paymentKindLabel(kind);
  }


  /**
   * Ticket status label.
   */
  ticketStatusLabel(status: string | null | undefined): string {
    return TICKET_STATUS_LABELS[String(status || '')] || String(status || '—');
  }

  /**
   * Ticket priority label; the API stores the enum without a label.
   */
  ticketPriority(priority: string | null | undefined): string {
    return TICKET_PRIORITY_LABELS[String(priority || '')] || String(priority || '—');
  }

  /**
   * Ticket status tone.
   */
  ticketTone(status: string | null | undefined): AdminTone {
    return ticketStatusTone(status);
  }

  /**
   * Whether the ticket can still be answered from its state.
   */
  canReply(ticket: AdminTicketRow | null): boolean {
    return Boolean(ticket) && this.canWrite() && !isChatGovernedTicket(ticket) && canTicketAction(ticket, 'reply');
  }

  /**
   * Whether the ticket can be marked resolved.
   */
  canResolve(ticket: AdminTicketRow | null): boolean {
    return Boolean(ticket) && this.canWrite() && !isChatGovernedTicket(ticket) && canTicketAction(ticket, 'resolve');
  }

  /**
   * Whether the ticket can be closed.
   */
  canClose(ticket: AdminTicketRow | null): boolean {
    return Boolean(ticket) && this.canWrite() && !isChatGovernedTicket(ticket) && canTicketAction(ticket, 'close');
  }

  /**
   * Title of the ticket action modal.
   */
  ticketActionTitle(): string {
    const titles: Record<TicketAction, string> = {
      reply: 'Phản hồi khách hàng',
      resolve: 'Đánh dấu đã giải quyết',
      close: 'Đóng phiếu hỗ trợ',
    };
    const action = this.ticketAction();
    return action ? titles[action] : 'Phiếu hỗ trợ';
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
   * Updates the return search box.
   */
  onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the return status filter.
   */
  onStatusChange(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the payment channel filter.
   */
  onPaymentChange(event: Event): void {
    this.paymentFilter.set((event.target as HTMLSelectElement).value as '' | 'cod' | 'online');
  }

  /**
   * Updates the ticket status filter.
   */
  onTicketStatusChange(event: Event): void {
    this.ticketStatus.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the ticket search (title, note, phone, email — matched server-side).
   */
  onTicketSearchInput(event: Event): void {
    this.ticketSearch.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the audit target filter.
   */
  onLogTargetInput(event: Event): void {
    this.logTarget.set((event.target as HTMLInputElement).value);
  }

  /**
   * Return status tone.
   */
  statusTone(status: string | null | undefined): AdminTone {
    return returnStatusTone(status);
  }

  /** Vietnamese label for an inbound/outbound shipment state. */
  shipmentStatusLabel(status: string | null | undefined): string {
    const labels: Record<string, string> = {
      pending: 'Chờ tạo vận đơn',
      label_ready: 'Đã tạo vận đơn, chờ ĐVVC lấy hàng',
      picked_up: 'ĐVVC đã lấy hàng',
      in_transit: 'Đang vận chuyển',
      delivered: 'Đã tới kho',
      failed: 'Vận chuyển thất bại',
      cancelled: 'Đã hủy vận đơn',
    };
    return labels[String(status || '')] || status || '—';
  }

  /** Vietnamese label for the warehouse disposition of one returned line. */
  dispositionLabel(disposition: string | null | undefined): string {
    const labels: Record<string, string> = {
      restock: 'Nhập lại kho',
      repair: 'Sửa chữa',
      scrap: 'Hủy',
      return_supplier: 'Trả nhà cung cấp',
    };
    return labels[String(disposition || '')] || disposition || '—';
  }

  /** Vietnamese label for one evidence kind. */
  evidenceLabel(kind: string | null | undefined): string {
    const labels: Record<string, string> = {
      request_photo: 'Ảnh khách gửi ban đầu',
      request_video: 'Video khách gửi ban đầu',
      packing_photo: 'Ảnh đóng gói',
      packing_video: 'Video đóng gói',
      pickup_photo: 'Ảnh ĐVVC lấy hàng',
      pickup_video: 'Video pickup',
      qa_photo: 'Ảnh kho kiểm hàng',
      qa_video: 'Video kho kiểm hàng',
      refund_proof: 'Chứng từ hoàn tiền',
    };
    return labels[String(kind || '')] || kind || 'Bằng chứng';
  }

  /**
   * Refund flow label.
   */
  flowLabel(flow: string | null | undefined): string {
    return REFUND_FLOW_LABELS[String(flow || '')] || '—';
  }

  /**
   * Payout-info state label.
   */
  receiverLabel(status: string | null | undefined): string {
    return REFUND_RECEIVER_STATUS_LABELS[String(status || '')] || '—';
  }

  /** Request-level outreach and payout-detail collection do not advance logistics or money. */
  readonly gates = { contact: contactAllowed, info: refundInfoAllowed };

  /** Reload entry used by the retry button of this queue. */
  loadReturns(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const params = {
      status: this.statusFilter(),
      q: this.search(),
      order_id: this.orderFilter(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    this.listRequest = forkJoin({
      list: this.api.listReturns(params, this.paymentFilter()).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được hàng đợi đổi trả.'));
          return of(EMPTY_RETURNS);
        }),
      ),
      pending: this.api.listReturns({ status: 'REQUESTED', limit: '1' }).pipe(catchError(() => of(EMPTY_RETURNS))),
      transit: this.api.listReturns({ status: 'RETURN_IN_TRANSIT', limit: '1' }).pipe(catchError(() => of(EMPTY_RETURNS))),
      tickets: this.api.listTickets({ status: 'open', limit: '1' }).pipe(catchError(() => of(EMPTY_TICKETS))),
      processing: this.api.listTickets({ status: 'processing', limit: '1' }).pipe(catchError(() => of(EMPTY_TICKETS))),
    }).subscribe((payload) => {
      const rows = adminListRows(payload.list);
      this.returns.set(rows);
      this.total.set(adminListCount(payload.list));
      this.openReturns.set(rows.filter((row) => isReturnOpen(row.status)).length);
      this.pendingReturns.set(adminListCount(payload.pending));
      this.awaitingReceipt.set(adminListCount(payload.transit));
      this.openTickets.set(adminListCount(payload.tickets));
      this.processingTickets.set(adminListCount(payload.processing));
      this.loading.set(false);
    });
  }

  /** Reload entry used by the retry button of this queue. */
  loadTickets(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    this.listRequest = this.api
      .listTickets({ status: this.ticketStatus(), q: this.ticketSearch(), limit: String(this.pageSize), offset: adminOffset(this.ticketsPage(), this.pageSize) })
      .pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được phiếu hỗ trợ.'));
          return of(EMPTY_TICKETS);
        }),
      )
      .subscribe((payload) => {
        this.tickets.set(adminListRows(payload));
        this.ticketsTotal.set(adminListCount(payload));
        this.loading.set(false);
      });
  }

  /** Reload entry used by the retry button of this queue. */
  loadLogs(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    this.listRequest = this.api
      .listServiceLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize), targetId: this.logTarget() })
      .pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký đổi trả.'));
          return of(EMPTY_LOGS);
        }),
      )
      .subscribe((payload) => {
        this.logs.set(adminListRows(payload));
        this.logsTotal.set(adminListCount(payload));
        this.loading.set(false);
      });
  }

}


/** Vietnamese label of a return type. */
function typeLabel(type: string | undefined): string {
  if (type === 'exchange') {
    return 'Đổi hàng';
  }
  return type === 'refund' ? 'Hoàn tiền' : type || '—';
}

/** Ticket status tone. */
function ticketStatusTone(status: string | null | undefined): AdminTone {
  if (status === 'resolved') {
    return 'success';
  }
  if (status === 'closed') {
    return 'neutral';
  }
  if (status === 'processing') {
    return 'info';
  }
  return 'warning';
}

/** Audit actor label. */
function actor(row: AdminAuditRow): string {
  return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
}

/** Reads a named control from the ticket action form. */
function readField(form: HTMLFormElement, name: string): string {
  const control = form.elements.namedItem(name) as HTMLTextAreaElement | HTMLInputElement | null;
  return control ? String(control.value).trim() : '';
}
