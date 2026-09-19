import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminChatMessageRow,
  AdminChatSessionRow,
  AdminOrderRow,
  AdminReturnRow,
  AdminTicketRow,
} from '../../core/admin-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type ServiceZone = 'chat' | 'returns' | 'support' | 'orders' | 'logs';
type ReturnAction = 'refund' | 'exchange' | 'reject' | 'reply' | 'close' | null;

const RETURN_LABELS: Record<string, string> = {
  pending: 'Chờ xử lý',
  approved: 'Đã duyệt',
  shipping_back: 'Đang gửi về',
  received: 'Đã nhận',
  completed: 'Hoàn tất',
  rejected: 'Từ chối',
  open: 'Mới',
  processing: 'Đang xử lý',
  resolved: 'Đã giải quyết',
  closed: 'Đã đóng',
};

@Component({
  selector: 'app-admin-returns-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination],
  templateUrl: './admin-returns.page.html',
})
export class AdminReturnsPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly zone = signal<ServiceZone>('chat');
  readonly returns = signal<AdminReturnRow[]>([]);
  readonly tickets = signal<AdminTicketRow[]>([]);
  readonly orders = signal<AdminOrderRow[]>([]);
  readonly chats = signal<AdminChatSessionRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly messages = signal<AdminChatMessageRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly selectedChat = signal<AdminChatSessionRow | null>(null);
  readonly actionType = signal<ReturnAction>(null);
  readonly selectedReturn = signal<AdminReturnRow | null>(null);
  readonly selectedTicket = signal<AdminTicketRow | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly chatError = signal<string | null>(null);
  readonly replyDraft = signal('');
  readonly chatFilter = signal('all');
  readonly chatProducts = signal<Array<{ product_id: string; name?: string; image_url?: string; sale_price?: number; base_price?: number }>>([]);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly returnsTotal = signal(0);
  readonly ticketsTotal = signal(0);
  readonly ordersTotal = signal(0);
  readonly logsTotal = signal(0);
  readonly pendingReturnCount = signal(0);
  readonly pendingTicketCount = signal(0);
  readonly completedReturnCount = signal(0);
  readonly canMutate = computed(() => this.session.canMutate('returns'));
  readonly canLookupOrders = computed(() => this.session.canAccessModule('orders'));
  readonly orderQuery = signal('');
  readonly selectedOrder = signal<AdminOrderRow | null>(null);
  readonly refundSuggestion = signal<number | null>(null);

  readonly pendingReturns = computed(() => this.pendingReturnCount());
  readonly pendingTickets = computed(() => this.pendingTicketCount());
  readonly highPriority = computed(() => this.pendingReturnCount() + this.pendingTicketCount());
  readonly completedToday = computed(() => this.completedReturnCount());
  readonly pagedReturns = computed(() => this.returns());
  readonly pagedTickets = computed(() => this.tickets());
  readonly pagedOrders = computed(() => this.orders());
  readonly pagedLogs = computed(() => this.logs());
  readonly returnPageCount = computed(() => Math.max(1, Math.ceil(this.returnsTotal() / this.pageSize)));
  readonly ticketPageCount = computed(() => Math.max(1, Math.ceil(this.ticketsTotal() / this.pageSize)));
  readonly orderPageCount = computed(() => Math.max(1, Math.ceil(this.ordersTotal() / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsTotal() / this.pageSize)));
  readonly returnRange = computed(() => adminRangeLabel(this.returnsTotal(), this.page(), this.pageSize, 'phiếu'));
  readonly ticketRange = computed(() => adminRangeLabel(this.ticketsTotal(), this.page(), this.pageSize, 'phiếu'));
  readonly orderRange = computed(() => adminRangeLabel(this.ordersTotal(), this.page(), this.pageSize, 'đơn'));
  readonly logRange = computed(() => adminRangeLabel(this.logsTotal(), this.page(), this.pageSize, 'nhật ký'));
  readonly visibleChats = computed(() => this.chats().filter((session) => session.is_active !== false));
  readonly pendingChatCount = computed(() => this.chats().filter((session) => session.handoff_status === 'requested').length);
  readonly canReply = computed(() => this.canMutate() && this.selectedChat()?.handoff_status === 'assigned');
  readonly canJoinChat = computed(() => {
    if (!this.canMutate()) {
      return false;
    }
    const status = this.selectedChat()?.handoff_status || 'ai';
    return status === 'ai' || status === 'requested';
  });
  readonly isClosedChat = computed(() => this.selectedChat()?.handoff_status === 'closed');

  constructor() {
    this.reload();
  }

  /**
   * Reloads the active CSKH zone from server-paged APIs.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const pageParams = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };
    const zone = this.zone();
    forkJoin({
      returns:
        zone === 'returns'
          ? this.api.listReturns(pageParams).pipe(
              catchError((error: unknown) => {
                this.loadError.set(adminErrorMessage(error));
                return of({ rows: [] as AdminReturnRow[], count: 0 });
              }),
            )
          : this.api.listReturns({ status: 'pending', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      pendingReturns: this.api.listReturns({ status: 'pending', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      completedReturns: this.api
        .listReturns({ status: 'completed', limit: '1' })
        .pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      tickets:
        zone === 'support'
          ? this.api.listTickets(pageParams).pipe(catchError(() => of({ rows: [] as AdminTicketRow[], count: 0 })))
          : this.api.listTickets({ status: 'open', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminTicketRow[], count: 0 }))),
      chats: this.api
        .listChatSessions(this.chatListParams())
        .pipe(catchError(() => of({ rows: [] as AdminChatSessionRow[] }))),
      allReturns: this.api.listReturns({ limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      allTickets: this.api.listTickets({ limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminTicketRow[], count: 0 }))),
      pendingTickets: this.api.listTickets({ status: 'open', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminTicketRow[], count: 0 }))),
      logs:
        zone === 'logs'
          ? this.api.listServiceLogs(pageParams).pipe(catchError(() => of({ rows: [] as AdminAuditRow[], count: 0 })))
          : of({ rows: [] as AdminAuditRow[], count: 0 }),
      orders:
        zone === 'orders'
          ? this.api
              .listOrders({
                q: this.orderQuery().trim(),
                limit: String(this.pageSize),
                offset: adminOffset(this.page(), this.pageSize),
              })
              .pipe(
                catchError((error: unknown) => {
                  this.loadError.set(adminErrorMessage(error, 'Bạn không có quyền tra cứu đơn hàng.'));
                  return of({ rows: [] as AdminOrderRow[], count: 0 });
                }),
              )
          : of({ rows: [] as AdminOrderRow[], count: 0 }),
    }).subscribe((payload) => {
      if (zone === 'returns') {
        this.returns.set(adminListRows(payload.returns));
        this.returnsTotal.set(adminListCount(payload.returns));
      } else {
        this.returnsTotal.set(adminListCount(payload.allReturns));
      }
      this.pendingReturnCount.set(adminListCount(payload.pendingReturns));
      this.completedReturnCount.set(adminListCount(payload.completedReturns));
      if (zone === 'support') {
        this.tickets.set(adminListRows(payload.tickets));
        this.ticketsTotal.set(adminListCount(payload.tickets));
      } else {
        this.ticketsTotal.set(adminListCount(payload.allTickets));
      }
      this.pendingTicketCount.set(adminListCount(payload.pendingTickets));
      this.chats.set(adminListRows(payload.chats).filter((session) => session.is_active !== false));
      const selectedId = this.selectedChat()?.session_id;
      if (selectedId) {
        const next = this.chats().find((session) => session.session_id === selectedId) || null;
        this.selectedChat.set(next);
      }
      if (zone === 'logs') {
        this.logs.set(adminListRows(payload.logs));
        this.logsTotal.set(adminListCount(payload.logs));
      }
      if (zone === 'orders') {
        this.orders.set(adminListRows(payload.orders));
        this.ordersTotal.set(adminListCount(payload.orders));
      }
      this.loading.set(false);
    });
  }

  /**
   * Switches the original CSKH workspace tabs.
   */
  setZone(zone: ServiceZone): void {
    this.zone.set(zone);
    this.page.set(1);
    this.selectedOrder.set(null);
    this.reload();
  }

  /**
   * Updates the CSKH order lookup query.
   */
  onOrderQuery(event: Event): void {
    this.orderQuery.set((event.target as HTMLInputElement).value);
  }

  /**
   * Runs the CSKH order lookup against the paged orders API.
   */
  searchOrders(): void {
    if (!this.canLookupOrders()) {
      this.loadError.set('Bạn không có quyền tra cứu đơn hàng.');
      return;
    }
    this.page.set(1);
    this.reload();
  }

  /**
   * Loads one order for support without exposing mutation actions.
   */
  selectOrder(order: AdminOrderRow): void {
    if (!this.canLookupOrders()) {
      this.loadError.set('Bạn không có quyền tra cứu đơn hàng.');
      return;
    }
    this.selectedOrder.set(order);
    this.api.getOrder(order.order_id).subscribe({
      next: (detail) => this.selectedOrder.set(detail),
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Selects a chat session and loads its messages.
   */
  selectChat(session: AdminChatSessionRow): void {
    this.selectedChat.set(session);
    this.chatError.set(null);
    this.api.getChatMessages(session.session_id, { limit: '150' }).subscribe({
      next: (payload) => {
        this.messages.set(payload.messages || []);
        this.chatProducts.set(payload.products || []);
      },
      error: (error: unknown) => this.chatError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Server filters for the CSKH chat sidebar.
   */
  private chatListParams(): Record<string, string> {
    const filter = this.chatFilter();
    const params: Record<string, string> = { limit: '50' };
    if (filter === 'ai' || filter === 'requested' || filter === 'assigned' || filter === 'closed') {
      params['handoffStatus'] = filter;
      return params;
    }
    params['handoffOnly'] = 'false';
    return params;
  }

  /**
   * Filters the original chat session list.
   */
  onChatFilter(event: Event): void {
    this.chatFilter.set((event.target as HTMLSelectElement).value || 'all');
    this.reload();
  }

  /**
   * Assigns the selected chat session to the current admin.
   */
  assignChat(): void {
    const session = this.selectedChat();
    if (!session || !this.canMutate()) {
      return;
    }
    this.api.assignChatSession(session.session_id, 'assigned').subscribe({
      next: (payload) => {
        if (payload.session) {
          this.selectedChat.set(payload.session);
        }
        this.reload();
      },
      error: (error: unknown) => this.chatError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Closes the selected chat session.
   */
  closeChat(): void {
    const session = this.selectedChat();
    if (!session || !this.canMutate()) {
      return;
    }
    this.api.assignChatSession(session.session_id, 'closed').subscribe({
      next: (payload) => {
        if (payload.session) {
          this.selectedChat.set(payload.session);
        }
        this.reload();
      },
      error: (error: unknown) => this.chatError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Sends an agent reply on the selected chat session.
   */
  sendReply(event: Event): void {
    event.preventDefault();
    const session = this.selectedChat();
    const message = this.replyDraft().trim();
    if (!session || !message || !this.canMutate()) {
      return;
    }
    this.api.sendChatReply(session.session_id, message).subscribe({
      next: (payload) => {
        if (payload.message) {
          this.messages.update((rows) => [...rows, payload.message!]);
        }
        if (payload.session) {
          this.selectedChat.set(payload.session);
        }
        this.replyDraft.set('');
        this.reload();
      },
      error: (error: unknown) => this.chatError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Updates the chat reply draft.
   */
  onReplyInput(event: Event): void {
    this.replyDraft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Opens a return or ticket action modal.
   */
  openReturnAction(type: 'refund' | 'exchange' | 'reject', returnId: string): void {
    const row = this.returns().find((item) => item.return_id === returnId) || null;
    this.selectedReturn.set(row);
    this.selectedTicket.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
    this.refundSuggestion.set(null);
    if (type === 'refund' && row?.order_id) {
      this.api.getOrder(row.order_id).subscribe({
        next: (order) => {
          // Ignore a stale response if the admin already switched to a different return.
          if (this.selectedReturn()?.return_id === returnId) {
            this.refundSuggestion.set(Number(order.total_amount) || null);
          }
        },
        error: () => {
          if (this.selectedReturn()?.return_id === returnId) {
            this.refundSuggestion.set(null);
          }
        },
      });
    }
  }

  /**
   * Opens a ticket reply/close modal.
   */
  openTicketAction(type: 'reply' | 'close', ticketId: string): void {
    this.selectedTicket.set(this.tickets().find((row) => row.ticket_id === ticketId) || null);
    this.selectedReturn.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
  }

  /**
   * Closes CSKH action modals.
   */
  closeOverlays(): void {
    this.actionType.set(null);
    this.selectedReturn.set(null);
    this.selectedTicket.set(null);
    this.actionError.set(null);
    this.refundSuggestion.set(null);
  }

  /**
   * Formats a currency amount for the refund suggestion hint.
   */
  money(value: number | undefined | null): string {
    return adminMoney(value);
  }

  /**
   * Submits a return or ticket action through the original APIs.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const type = this.actionType();
    const form = event.target as HTMLFormElement;
    const note = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value.trim() || '';
    const amount = Number((form.elements.namedItem('amount') as HTMLInputElement | null)?.value || 0);
    const ret = this.selectedReturn();
    const ticket = this.selectedTicket();
    if (ret && ret.version) {
      const request$ =
        type === 'refund'
          ? this.api.approveRefund(ret.return_id, { refundAmount: amount, adminNote: note, expectedVersion: ret.version })
          : type === 'exchange'
            ? this.api.approveExchange(ret.return_id, { adminNote: note, expectedVersion: ret.version })
            : this.api.rejectReturn(ret.return_id, { reason: note, expectedVersion: ret.version });
      request$.subscribe({
        next: () => {
          this.closeOverlays();
          this.reload();
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
      return;
    }
    if (ticket && ticket.version) {
      const request$ =
        type === 'reply'
          ? this.api.respondTicket(ticket.ticket_id, { response: note, expectedVersion: ticket.version })
          : this.api.closeTicket(ticket.ticket_id, { reason: note, expectedVersion: ticket.version });
      request$.subscribe({
        next: () => {
          this.closeOverlays();
          this.reload();
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
    }
  }

  /**
   * Moves list pagination for the active table.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Customer label used by the original chat sidebar.
   */
  chatName(session: AdminChatSessionRow): string {
    return session.metadata?.guest_email || session.guest_id?.slice(0, 8) || 'Khách';
  }

  /**
   * Preview line used by the original chat sidebar.
   */
  chatPreview(session: AdminChatSessionRow): string {
    return session.last_message_preview || session.title || session.preview || 'Chat';
  }

  /**
   * Handoff badge used by the original chat sidebar.
   */
  chatStatus(session: AdminChatSessionRow): string {
    const status = session.handoff_status || 'ai';
    if (status === 'requested') {
      return 'Chờ';
    }
    if (status === 'assigned') {
      return 'Đang xử lý';
    }
    if (status === 'closed') {
      return 'Đã đóng';
    }
    return 'AI';
  }

  /**
   * Status tone used by the original chat badges.
   */
  chatStatusTone(session: AdminChatSessionRow): string {
    const status = session.handoff_status || 'ai';
    if (status === 'requested') {
      return 'pending';
    }
    if (status === 'assigned' || status === 'closed' || status === 'ai') {
      return status;
    }
    return 'ai';
  }

  /**
   * Product cards attached to a chat message.
   */
  productsOf(message: AdminChatMessageRow): Array<{ product_id: string; name?: string; image_url?: string; sale_price?: number; base_price?: number }> {
    const ids = new Set([...(message.product_ids || []), ...(message.metadata?.product_ids || [])]);
    return this.chatProducts().filter((product) => ids.has(product.product_id));
  }

  /**
   * Formats a product price in the original chat cards.
   */
  productPrice(product: { sale_price?: number; base_price?: number }): string {
    return `${Number(product.sale_price || product.base_price || 0).toLocaleString('vi-VN')}₫`;
  }

  /**
   * Sender class used by the original chat thread.
   */
  messageClass(message: AdminChatMessageRow): string {
    if (message.sender === 'user') {
      return 'admin-chat-msg--user';
    }
    if (message.sender === 'agent') {
      return 'admin-chat-msg--agent';
    }
    return 'admin-chat-msg--bot';
  }

  /**
   * Sender label used by the original chat thread.
   */
  messageLabel(message: AdminChatMessageRow): string {
    if (message.sender === 'user') {
      return 'KH';
    }
    if (message.sender === 'agent') {
      return 'CSKH';
    }
    return 'AI';
  }

  /**
   * Status badge text for returns and tickets.
   */
  statusLabel(status: string | undefined): string {
    return RETURN_LABELS[status || ''] || status || '—';
  }

  /**
   * Formats a CSKH timestamp.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Modal title for return/ticket actions.
   */
  actionTitle(): string {
    const type = this.actionType();
    if (type === 'refund') {
      return 'Duyệt hoàn tiền';
    }
    if (type === 'exchange') {
      return 'Duyệt đổi hàng';
    }
    if (type === 'reject') {
      return 'Từ chối phiếu';
    }
    if (type === 'reply') {
      return 'Phản hồi phiếu hỗ trợ';
    }
    return 'Đóng phiếu hỗ trợ';
  }
}
