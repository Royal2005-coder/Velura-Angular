import { Subscription, catchError, forkJoin, of, skip } from 'rxjs';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, type ParamMap } from '@angular/router';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminOrderRow,
  AdminReturnRow,
  AdminReturnStatus,
  AdminTicketRow,
} from '../../core/admin-erp-api.service';
import { orderFocusLink, returnFocusLink, type OrderTraceLink } from '../../core/admin-erp-order-trace';
import {
  CONTACT_RESULTS,
  MIN_NOTE_LENGTH,
  REFUND_FLOW_LABELS,
  REFUND_RECEIVER_STATUS_LABELS,
  RETURN_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  approvalNeedsReason,
  canTicketAction,
  contactAllowed,
  exchangeApprovalAllowed,
  gatewayRefundAllowed,
  isChatGovernedTicket,
  isReturnOpen,
  manualReturnTransitions,
  paymentKindLabel,
  receiptAllowed,
  refundApprovalAllowed,
  refundInfoAllowed,
  rejectAllowed,
  returnStatusLabel,
  returnStatusTone,
  stripeRefundAllowed,
  manualRefundAllowed,
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
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';
import { AdminTone, TICKET_STATUS_LABELS } from '../../core/admin-erp-status-labels';
import { ChatDeskComponent } from './chat-desk.component';
import { ReturnFlowComponent, ReturnFlowKind } from './return-flow.component';

type DeskTab = 'returns' | 'tickets' | 'chat' | 'logs';
type TicketAction = 'reply' | 'resolve' | 'close';

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
    AdminErpModal,
    AdminErpStatusBadge,
    AdminErpIcon,
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

  readonly selectedTicket = signal<AdminTicketRow | null>(null);
  readonly ticketAction = signal<TicketAction | null>(null);
  readonly ticketError = signal<string | null>(null);
  readonly ticketBusy = signal(false);

  readonly selectedLog = signal<AdminAuditRow | null>(null);

  readonly canRead = computed(() => this.session.can('read', 'returns'));
  readonly canWrite = computed(() => this.session.can('update', 'returns'));
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
  readonly flowNeedsReason = computed(() => approvalNeedsReason(this.selected()));

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

  readonly nextSteps = computed(() =>
    manualReturnTransitions(this.selected()?.status).map((value) => ({ value, label: returnStatusLabel(value) })),
  );

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
    this.applyDeepLink(this.route.snapshot.queryParamMap);
    this.route.queryParamMap.pipe(skip(1), takeUntilDestroyed(this.destroyRef)).subscribe((params) => this.applyDeepLink(params));
  }

  /**
   * Applies an inbound deep link: the queue to show, the order the return list is scoped to and
   * the return to open. Links can arrive while this workspace is already on screen, so every
   * param change is re-applied instead of only the first load.
   */
  private applyDeepLink(params: ParamMap): void {
    const tab = params.get('tab');
    if (tab === 'returns' || tab === 'tickets' || tab === 'chat' || tab === 'logs') {
      this.tab.set(tab);
    }
    this.orderFilter.set(params.get('order_id') || '');
    this.search.set(params.get('q') || '');
    this.page.set(1);
    this.reload();
    const focus = params.get('focus');
    if (focus) {
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
    if (tab !== 'returns' && tab !== 'tickets' && tab !== 'chat' && tab !== 'logs') {
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
  openReturn(row: unknown): void {
    const id = (row as AdminReturnRow).return_id;
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.gatewayNote.set(null);
    this.api.getReturn(id).subscribe({
      next: (record) => {
        this.selected.set(record);
        this.detailLoading.set(false);
        this.loadOrderContext(record.order_id);
      },
      error: (error: unknown) => {
        this.detailLoading.set(false);
        this.selected.set(row as AdminReturnRow);
        this.detailError.set(adminErrorMessage(error, 'Không tải được chi tiết phiếu.'));
        this.loadOrderContext((row as AdminReturnRow).order_id);
      },
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
      .subscribe((order) => this.orderContext.set(order));
  }

  /**
   * Opens one return write flow.
   */
  openFlow(flow: ReturnFlowKind): void {
    if (!this.canWrite() || !flow) {
      return;
    }
    this.flow.set(flow);
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
  onFlowDone(): void {
    const id = this.selected()?.return_id;
    this.flow.set(null);
    if (id) {
      this.openReturn({ return_id: id } as AdminReturnRow);
    }
    this.loadReturns();
  }

  /**
   * Runs the gateway refund for a Stripe return; the step needs no extra input.
   */
  runStripeRefund(): void {
    const record = this.selected();
    if (!record || !this.canWrite() || !stripeRefundAllowed(record) || record.version == null) {
      return;
    }
    this.detailLoading.set(true);
    this.api.triggerStripeRefund(record.return_id, { expectedVersion: record.version }).subscribe({
      next: (result) => {
        this.detailLoading.set(false);
        this.gatewayNote.set(gatewayNote(result.refund));
        this.openReturn({ return_id: record.return_id } as AdminReturnRow);
        this.loadReturns();
      },
      error: (error: unknown) => {
        this.detailLoading.set(false);
        this.detailError.set(adminErrorMessage(error, 'Cổng hoàn tiền chưa phản hồi.'));
      },
    });
  }

  /**
   * Advances the workflow one legal step, using the status chosen in the drawer.
   */
  moveStep(status: string): void {
    const record = this.selected();
    if (!record || record.version == null || !this.canWrite()) {
      return;
    }
    if (status === 'RECEIVED') {
      this.flow.set('receipt');
      return;
    }
    if (!plainSteps(status)) {
      this.flow.set('status');
      return;
    }
    this.api
      .updateReturnStatus(record.return_id, {
        status: status as AdminReturnStatus,
        expectedVersion: record.version,
      })
      .subscribe({
        next: () => this.onFlowDone(),
        error: (error: unknown) => this.detailError.set(adminErrorMessage(error)),
      });
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
    this.selected.set(null);
    this.selectedTicket.set(null);
    this.selectedLog.set(null);
    this.orderContext.set(null);
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
   * Received quantity recorded for one registered line.
   */
  receivedQuantity(orderItemId: string | undefined): number | null {
    const id = String(orderItemId || '');
    const receipt = (this.selected()?.qa_item_receipts || []).find((row) => row.orderItemId === id);
    return receipt ? Number(receipt.receivedQuantity) : null;
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

  /**
   * Steps still legal from the stored state.
   */
  canReach(row: AdminReturnRow | null, status: string): boolean {
    return manualReturnTransitions(row?.status).includes(status);
  }

  /**
   * Gate helpers used by the drawer buttons.
   */
  readonly gates = {
    contact: contactAllowed,
    refund: refundApprovalAllowed,
    exchange: exchangeApprovalAllowed,
    reject: rejectAllowed,
    receipt: receiptAllowed,
    gateway: gatewayRefundAllowed,
    manual: manualRefundAllowed,
    stripe: stripeRefundAllowed,
    info: refundInfoAllowed,
  };

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
      .listTickets({ status: this.ticketStatus(), limit: String(this.pageSize), offset: adminOffset(this.ticketsPage(), this.pageSize) })
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

/** Steps the API accepts with no tracking, evidence or reason attached. */
const PLAIN_STEPS: readonly string[] = ['CONTACTING', 'WAITING_RETURN'];

/** True when a step can be written without extra evidence. */
function plainSteps(status: string): boolean {
  return PLAIN_STEPS.includes(status);
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

/** Gateway answer in operator language. */
function gatewayNote(refund: { status: string; message?: string } | null): string {
  if (!refund) {
    return 'Cổng không trả về trạng thái. Kiểm lại giao dịch trước khi thử lại.';
  }
  if (refund.status === 'refunded') {
    return 'Stripe đã hoàn tiền. Phiếu sẽ được đánh dấu hoàn tất theo luồng.';
  }
  if (refund.status === 'requested') {
    return 'Đã gửi yêu cầu hoàn tiền tới Stripe; chờ cổng xác nhận.';
  }
  if (refund.status === 'skipped') {
    return 'Cổng bỏ qua giao dịch này; kiểm tra lại số tiền hoàn.';
  }
  return refund.message || 'Hoàn tiền qua Stripe thất bại. Kiểm lại giao dịch rồi thử lại.';
}

/** Reads a named control from the ticket action form. */
function readField(form: HTMLFormElement, name: string): string {
  const control = form.elements.namedItem(name) as HTMLTextAreaElement | HTMLInputElement | null;
  return control ? String(control.value).trim() : '';
}
