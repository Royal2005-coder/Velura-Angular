import { AdminDialogDirective } from '../../shared/admin-dialog.directive';
import { finalize } from 'rxjs';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { forkJoin, of , Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminChatMessageRow,
  AdminChatSessionRow,
  AdminOrderRow,
  AdminReturnRow,
  AdminReturnStatus,
  AdminTicketRow,
} from '../../core/admin-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-format';
import {
  ORDER_STATUS_LABELS,
  RETURN_REASON_LABELS,
  RETURN_STATUS_LABELS,
  statusLabelFrom,
  TICKET_STATUS_LABELS,
} from '../../core/admin-status-labels';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type ServiceZone = 'chat' | 'returns' | 'support' | 'orders' | 'logs';
type ReturnAction = 'refund' | 'exchange' | 'reject' | 'reply' | 'resolve' | 'close' | null;
type TicketAction = 'reply' | 'resolve' | 'close';
/** A warehouse check for one registered return line. */
interface ReceiptLine { orderItemId: string; expectedQuantity: number; receivedQuantity: string; confirmedItemId: string; matchesProduct: boolean; }


/**
 * Máy trạng thái phiếu hỗ trợ, khớp với `SUPPORT_TICKET_TRANSITIONS` phía API.
 *
 * Giao diện trước đây cho bấm "Phản hồi" trên mọi phiếu chưa đóng, kể cả phiếu đã
 * giải quyết — bấm xong API trả 422 và CSKH không hiểu vì sao. Bảng này để nút chỉ
 * hiện ra khi bước chuyển đó thật sự đi được.
 */
const TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['processing', 'closed'],
  processing: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

/** Trạng thái đích mà mỗi thao tác sẽ ghi. */
const TICKET_ACTION_TARGET: Record<TicketAction, string> = {
  reply: 'processing',
  resolve: 'resolved',
  close: 'closed',
};

@Component({
  selector: 'app-admin-returns-page',
  imports: [AdminDialogDirective, AdminEmptyState, AdminIcon, AdminPagination],
  templateUrl: './admin-returns.page.html',
})
export class AdminReturnsPage {
  private listRequest = new Subscription();
  private messageRequest = new Subscription();
  private receiveRequest = new Subscription();
  private returnDetailRequest = new Subscription();
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
  readonly hasLoadedOnce = signal(false);
  readonly chatLoading = signal(false);
  readonly submitting = signal(false);
  readonly qaLoading = signal(false);
  readonly qaSubmitting = signal(false);
  readonly qaLines = signal<ReceiptLine[]>([]);
  readonly qaReady = computed(() => !this.qaLoading() && this.qaLines().length > 0);
  readonly selectedChat = signal<AdminChatSessionRow | null>(null);
  readonly actionType = signal<ReturnAction>(null);
  readonly selectedReturn = signal<AdminReturnRow | null>(null);
  readonly selectedTicket = signal<AdminTicketRow | null>(null);
  readonly returnDetailOpen = signal(false);
  readonly ticketDetailOpen = signal(false);
  readonly lightboxImage = signal<string | null>(null);
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
  readonly receiveTarget = signal<AdminReturnRow | null>(null);
  readonly qaResult = signal('');
  readonly qaProof = signal('');
  readonly qaQty = signal('');
  readonly qaItemId = signal('');
  readonly expectedQty = signal(0);
  readonly expectedItemId = signal('');
  readonly qaError = signal<string | null>(null);
  readonly qaFailureNote = signal('');
  readonly contactResult = signal('');
  readonly contactNote = signal('');
  readonly contactError = signal<string | null>(null);
  readonly shipmentTarget = signal<{ row: AdminReturnRow; status: 'RETURN_IN_TRANSIT' | 'EXCHANGE_SHIPPING' } | null>(null);
  readonly shipmentTracking = signal('');
  readonly shipmentError = signal<string | null>(null);
  readonly manualRefundTarget = signal<AdminReturnRow | null>(null);
  readonly manualRefundProof = signal('');

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
  readonly canReply = computed(() => this.canMutate() && !this.isClosedChat());
  readonly canJoinChat = computed(() => {
    if (!this.canMutate()) {
      return false;
    }
    const status = this.selectedChat()?.handoff_status || 'ai';
    return status === 'ai' || status === 'requested';
  });
  readonly isClosedChat = computed(() => this.selectedChat()?.handoff_status === 'closed');

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.messageRequest.unsubscribe(); this.receiveRequest.unsubscribe(); this.returnDetailRequest.unsubscribe(); });
    inject(DestroyRef).onDestroy(() => this.listRequest.unsubscribe());
    inject(AdminRefreshService).register(() => {
      if (!this.loading() && !this.submitting() && !this.actionType() && !this.receiveTarget() && !this.shipmentTarget() && !this.manualRefundTarget()) this.reload();
    }, inject(DestroyRef));
    this.reload();
  }

  /**
   * Reloads the active CSKH zone from server-paged APIs.
   */
  reload(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const pageParams = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };
    const zone = this.zone();
    this.listRequest = forkJoin({
      returns:
        zone === 'returns'
          ? this.api.listReturns(pageParams).pipe(
              catchError((error: unknown) => {
                this.loadError.set(adminErrorMessage(error));
                return of({ rows: [] as AdminReturnRow[], count: 0 });
              }),
            )
          : this.api.listReturns({ status: 'REQUESTED', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      pendingReturns: this.api.listReturns({ status: 'REQUESTED', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      completedReturns: this.api
        .listReturns({ status: 'COMPLETED', limit: '1' })
        .pipe(catchError(() => of({ rows: [] as AdminReturnRow[], count: 0 }))),
      tickets:
        zone === 'support'
          ? this.api.listTickets(pageParams).pipe(catchError((error: unknown) => { this.loadError.set(adminErrorMessage(error, 'Không thể tải phiếu hỗ trợ')); return of({ rows: [] as AdminTicketRow[], count: 0 }); }))
          : this.api.listTickets({ status: 'open', limit: '1' }).pipe(catchError(() => of({ rows: [] as AdminTicketRow[], count: 0 }))),
      chats: this.api
        .listChatSessions(this.chatListParams())
        .pipe(catchError((error: unknown) => { if (zone === 'chat') this.loadError.set(adminErrorMessage(error, 'Không thể tải phiên chat')); return of({ rows: [] as AdminChatSessionRow[] }); })),
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
      this.hasLoadedOnce.set(true);
      if (zone === 'chat' && this.selectedChat()) this.loadChatMessages(this.selectedChat()!.session_id);
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
    this.selectedChat.set(session); this.chatError.set(null); this.messages.set([]); this.chatProducts.set([]); this.replyDraft.set('');
    this.loadChatMessages(session.session_id);
  }

  /** Updates conversation data without discarding the agent's current draft. */
  private loadChatMessages(sessionId: string): void {
    this.messageRequest.unsubscribe(); this.chatLoading.set(true);
    this.messageRequest = this.api.getChatMessages(sessionId, { limit: '150' }).subscribe({
      next: (payload) => {
        if (this.selectedChat()?.session_id !== sessionId) return;
        this.chatLoading.set(false); this.messages.set(payload.messages || []); this.chatProducts.set(payload.products || []);
      },
      error: (error: unknown) => { this.chatLoading.set(false); if (this.selectedChat()?.session_id === sessionId) this.chatError.set(adminErrorMessage(error)); },
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
    if (!session || !this.canJoinChat() || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.api.assignChatSession(session.session_id, 'assigned').pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: (payload) => {
        if (payload.session && this.selectedChat()?.session_id === session.session_id) {
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
    if (!session || !this.canMutate() || this.isClosedChat() || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.api.assignChatSession(session.session_id, 'closed').pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: (payload) => {
        if (payload.session && this.selectedChat()?.session_id === session.session_id) {
          this.selectedChat.set(payload.session);
        }
        this.reload();
      },
      error: (error: unknown) => this.chatError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Sends an agent reply on the selected chat session, tự động tiếp nhận phiên nếu chưa assign.
   */
  sendReply(event: Event): void {
    event.preventDefault();
    const session = this.selectedChat();
    const message = this.replyDraft().trim();
    if (!session || !message || !this.canReply() || this.submitting()) {
      return;
    }

    this.submitting.set(true);
    const doSend = () => {
      this.api.sendChatReply(session.session_id, message).pipe(finalize(() => this.submitting.set(false))).subscribe({
        next: (payload) => {
          if (this.selectedChat()?.session_id !== session.session_id) return;
          if (payload.message) {
            this.messages.update((rows) => [...rows, payload.message!]);
          }
          if (payload.session) {
            this.selectedChat.set(payload.session);
          }
          this.replyDraft.set('');
          this.reload();
        },
        error: (error: unknown) => { this.submitting.set(false); this.chatError.set(adminErrorMessage(error)); },
      });
    };

    if (session.handoff_status !== 'assigned') {
      this.api.assignChatSession(session.session_id, 'assigned').subscribe({
        next: (payload) => {
          if (payload.session && this.selectedChat()?.session_id === session.session_id) {
            this.selectedChat.set(payload.session);
          }
          doSend();
        },
        error: (error: unknown) => { this.submitting.set(false); this.chatError.set(adminErrorMessage(error)); },
      });
    } else {
      doSend();
    }
  }

  /**
   * Updates the chat reply draft.
   */
  onReplyInput(event: Event): void {
    this.replyDraft.set((event.target as HTMLInputElement).value);
  }

  /**
   * What the customer asked for. The API stores `return_type`, not `request_type`.
   */
  returnKind(row: AdminReturnRow): string {
    const type = row.return_type || row.request_type;
    if (type === 'refund') {
      return 'Hoàn tiền';
    }
    if (type === 'exchange') {
      return 'Đổi hàng';
    }
    return type || '—';
  }

  /**
   * Pending actions that match the customer's request. Reject stays available.
   */
  showReturnAction(row: AdminReturnRow, type: 'refund' | 'exchange'): boolean {
    const asked = row.return_type || row.request_type;
    return !asked || asked === type;
  }

  /**
   * Opens a return or ticket action modal.
   */
  openReturnAction(type: 'refund' | 'exchange' | 'reject', returnId: string): void {
    const row = this.returns().find((item) => item.return_id === returnId) || (this.selectedReturn()?.return_id === returnId ? this.selectedReturn() : null);
    if (!row || !this.canMutate() || (type !== 'reject' && row.status !== 'CONTACTING') || (type === 'reject' && !['REQUESTED', 'CONTACTING', 'WAITING_RETURN'].includes(row.status || ''))) return;
    this.selectedReturn.set(row);
    this.selectedTicket.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
    this.refundSuggestion.set(null);
    if (type === 'refund') {
      // Số tiền hoàn lấy theo đúng những món khách gửi trả (API tính từ return_item),
      // không lấy tổng đơn: một đơn nhiều món mà khách chỉ trả một món thì hoàn cả đơn
      // là thất thoát.
      this.api.getReturn(returnId).subscribe({
        next: (detail) => {
          // Bỏ qua phản hồi cũ nếu CSKH đã chuyển sang phiếu khác.
          if (this.selectedReturn()?.return_id === returnId) {
            this.selectedReturn.set(detail);
            this.refundSuggestion.set(Number(detail.refundable_amount) || null);
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
   * Cho biết một thao tác có hợp lệ với trạng thái hiện tại của phiếu hay không.
   *
   * Trả lời lại một phiếu đang xử lý không phải là bước chuyển trạng thái nên luôn
   * được phép; các thao tác còn lại phải nằm trong bảng chuyển.
   */
  canTicketAction(row: AdminTicketRow, type: TicketAction): boolean {
    const from = row.status || '';
    const target = TICKET_ACTION_TARGET[type];
    if (from === target) {
      return true;
    }
    return (TICKET_TRANSITIONS[from] || []).includes(target);
  }

  /**
   * Opens a ticket reply/resolve/close modal.
   */
  openTicketAction(type: TicketAction, ticketId: string): void {
    this.selectedTicket.set(this.tickets().find((row) => row.ticket_id === ticketId) || null);
    this.selectedReturn.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
  }

  /**
   * Opens the return request detail drawer.
   */
  openReturnDetail(returnId: string): void {
    this.returnDetailRequest.unsubscribe();
    const cached = this.returns().find((r) => r.return_id === returnId) || null;
    this.selectedReturn.set(cached);
    this.selectedTicket.set(null);
    this.returnDetailOpen.set(true);
    this.ticketDetailOpen.set(false);
    this.actionType.set(null);
    this.actionError.set(null);
    this.contactResult.set(''); this.contactNote.set(''); this.contactError.set(null);
    this.returnDetailRequest = this.api.getReturn(returnId).subscribe({
      next: (full) => {
        if (this.returnDetailOpen() && (!this.selectedReturn() || this.selectedReturn()?.return_id === returnId)) {
          this.selectedReturn.set(full);
        }
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Opens the support ticket detail drawer.
   */
  openTicketDetail(ticketId: string): void {
    const cached = this.tickets().find((t) => t.ticket_id === ticketId) || null;
    this.selectedTicket.set(cached);
    this.selectedReturn.set(null);
    this.ticketDetailOpen.set(true);
    this.returnDetailOpen.set(false);
    this.actionType.set(null);
    this.actionError.set(null);
    this.api.getTicket(ticketId).subscribe({
      next: (full) => {
        if (this.selectedTicket()?.ticket_id === ticketId) {
          this.selectedTicket.set(full);
        }
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  openLightbox(image: string): void {
    this.lightboxImage.set(image);
  }

  closeLightbox(): void {
    this.lightboxImage.set(null);
  }

  returnStepIndex(status: string | undefined): number {
    return this.returnPipeline().findIndex((step) => step.status === status);
  }

  /** Shows the actual branch; exception/cancellation states remain explicit badges. */
  readonly returnPipeline = computed(() => {
    const exchange = this.selectedReturn()?.return_type === 'exchange' || this.selectedReturn()?.request_type === 'exchange';
    const codes: AdminReturnStatus[] = ['REQUESTED', 'CONTACTING', 'WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED', ...(exchange ? ['EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING'] as const : ['REFUND_PROCESSING', 'REFUNDED'] as const), 'COMPLETED'];
    return codes.map((status, idx) => ({ status, idx, label: RETURN_STATUS_LABELS[status] }));
  });

  /**
   * Closes CSKH action modals and detail drawers.
   */
  closeOverlays(): void {
    if (this.submitting()) return;
    this.returnDetailRequest.unsubscribe();
    this.actionType.set(null);
    this.selectedReturn.set(null);
    this.selectedTicket.set(null);
    this.actionError.set(null);
    this.refundSuggestion.set(null);
    this.returnDetailOpen.set(false);
    this.ticketDetailOpen.set(false);
    this.lightboxImage.set(null);
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
    if (this.submitting() || !this.canMutate()) return;
    const type = this.actionType();
    if (!type) return;
    const form = event.target as HTMLFormElement;
    const note = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value.trim() || '';
    const amount = Number((form.elements.namedItem('amount') as HTMLInputElement | null)?.value || 0);
    const ret = this.selectedReturn();
    const ticket = this.selectedTicket();
    if (note.length < 10) {
      this.actionError.set('Ghi rõ nội dung xử lý, tối thiểu 10 ký tự.');
      return;
    }
    if (type === 'refund' && (!Number.isFinite(amount) || amount <= 0 || (this.refundSuggestion() != null && amount > this.refundSuggestion()!))) {
      this.actionError.set('Số tiền hoàn phải lớn hơn 0 và không vượt giá trị hàng trả.');
      return;
    }
    if (ret && ret.version != null && ['refund', 'exchange', 'reject'].includes(type)) {
      if ((type !== 'reject' && ret.status !== 'CONTACTING') || (type === 'reject' && !['REQUESTED', 'CONTACTING', 'WAITING_RETURN'].includes(ret.status || ''))) {
        this.actionError.set('Liên hệ khách hàng trước khi duyệt; trạng thái phiếu phải còn cho phép xử lý.'); return;
      }
      this.submitting.set(true);
      const request$ =
        type === 'refund'
          ? this.api.approveRefund(ret.return_id, { refundAmount: amount, adminNote: note, expectedVersion: ret.version })
          : type === 'exchange'
            ? this.api.approveExchange(ret.return_id, { adminNote: note, expectedVersion: ret.version })
            : this.api.rejectReturn(ret.return_id, { reason: note, expectedVersion: ret.version });
      request$.pipe(finalize(() => this.submitting.set(false))).subscribe({
        next: () => {
          this.submitting.set(false);
          this.closeOverlays();
          this.reload();
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
      return;
    }
    if (ticket && ticket.version != null && ['reply', 'resolve', 'close'].includes(type)) {
      if (!this.canTicketAction(ticket, type as TicketAction)) return;
      this.submitting.set(true);
      const request$ =
        type === 'reply'
          ? this.api.respondTicket(ticket.ticket_id, { response: note, expectedVersion: ticket.version })
          : type === 'resolve'
            ? this.api.resolveTicket(ticket.ticket_id, { adminNote: note, expectedVersion: ticket.version })
            : this.api.closeTicket(ticket.ticket_id, { reason: note, expectedVersion: ticket.version });
      request$.pipe(finalize(() => this.submitting.set(false))).subscribe({
        next: () => {
          this.submitting.set(false);
          this.closeOverlays();
          this.reload();
        },
        error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
      });
      return;
    }
    this.actionError.set('Thiếu phiên bản mới nhất của phiếu. Mở lại trước khi xử lý.');
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
   * Offers only operator transitions; payment gateway owns both refund states.
   */
  nextReturnStep(row: AdminReturnRow): { status: string; label: string } | null {
    const steps: Record<string, { status: string; label: string }> = {
      WAITING_RETURN: { status: 'RETURN_IN_TRANSIT', label: 'Ghi nhận khách gửi hàng' },
      RETURN_IN_TRANSIT: { status: 'RECEIVED', label: 'QA và nhận hàng' },
      REFUNDED: { status: 'COMPLETED', label: 'Hoàn tất yêu cầu' },
      EXCHANGE_PREPARING: { status: 'EXCHANGE_SHIPPING', label: 'Giao hàng thay thế' },
      EXCHANGE_SHIPPING: { status: 'COMPLETED', label: 'Xác nhận giao hàng thay thế' },
      NEEDS_SUPPORT: { status: 'CONTACTING', label: 'Tiếp tục hỗ trợ' },
    };
    if (row.status === 'RECEIVED' && row.condition_check_result === 'qa_pass' && (row.return_type === 'exchange' || row.request_type === 'exchange')) return { status: 'EXCHANGE_PREPARING', label: 'Chuẩn bị đơn hàng thay thế' };
    return steps[row.status || ''] || null;
  }

  /**
   * Nhãn lý do khách đã chọn trong dropdown, không hiện mã tiếng Anh.
   */
  /**
   * Flags an untouched request after 24 hours; never cancels or rejects it.
   */
  contactOverdue(row: AdminReturnRow): boolean {
    if (row.status !== 'REQUESTED') return false;
    if ((row.admin_note || '').includes('[CSKH]')) return false;
    const created = Date.parse(row.created_at || '');
    if (!Number.isFinite(created)) return false;
    return Date.now() - created > 24 * 60 * 60 * 1000;
  }

  setContactResult(event: Event): void {
    this.contactResult.set((event.target as HTMLSelectElement).value);
  }

  setContactNote(event: Event): void {
    this.contactNote.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Lưu kết quả gọi khách. Không tự duyệt hay từ chối phiếu.
   */
  saveContact(row: AdminReturnRow): void {
    if (!this.canMutate() || this.submitting() || !['REQUESTED', 'CONTACTING', 'NEEDS_SUPPORT'].includes(row.status || '')) return;
    if (!this.contactResult() || this.contactNote().trim().length < 10) {
      this.contactError.set('Chọn kết quả liên hệ thực tế và ghi chú ít nhất 10 ký tự.'); return;
    }
    if (row.version == null) {
      this.contactError.set('Thiếu phiên bản phiếu.');
      return;
    }
    this.contactError.set(null);
    this.submitting.set(true);
    this.api.recordReturnContact(row.return_id, {
      result: this.contactResult(),
      note: this.contactNote().trim(),
      expectedVersion: row.version,
    }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => {
        this.contactResult.set('');
        this.contactNote.set('');
        this.openReturnDetail(row.return_id);
        this.reload();
      },
      error: (error: unknown) => this.contactError.set(adminErrorMessage(error)),
    });
  }

  returnReasonLabel(row: AdminReturnRow): string {
    const code = row.reason || '';
    return RETURN_REASON_LABELS[code] || row.description || 'Chưa chọn lý do';
  }

  /**
   * Mở form QA trước khi ghi nhận hàng hoàn trả thành công.
   */
  openReceive(row: AdminReturnRow): void {
    if (!this.canMutate() || this.qaSubmitting() || row.status !== 'RETURN_IN_TRANSIT') return;
    this.receiveRequest.unsubscribe(); this.receiveTarget.set(row); this.qaResult.set(''); this.qaProof.set(''); this.qaQty.set(''); this.qaItemId.set(''); this.expectedQty.set(0); this.expectedItemId.set(''); this.qaLines.set([]); this.qaError.set(null); this.qaFailureNote.set(''); this.qaLoading.set(true);
    this.receiveRequest = this.api.getReturn(row.return_id).subscribe({
      next: (full) => {
        if (this.receiveTarget()?.return_id !== row.return_id) return;
        const lines = full.lines || [];
        this.qaLoading.set(false);
        if (!lines.length || lines.some((line) => !line.order_item_id || Number(line.quantity) < 1)) { this.qaError.set('Phiếu thiếu mã hoặc số lượng dòng hàng hợp lệ. Đối chiếu với CSKH trước khi nhận hàng.'); return; }
        this.expectedQty.set(lines.reduce((sum, line) => sum + Number(line.quantity), 0)); this.expectedItemId.set(lines[0].order_item_id || '');
        this.qaLines.set(lines.map((line) => ({ orderItemId: line.order_item_id!, expectedQuantity: Number(line.quantity), receivedQuantity: '', confirmedItemId: '', matchesProduct: false })));
        this.receiveTarget.set({ ...row, ...full, version: full.version ?? row.version });
      },
      error: (error: unknown) => { this.qaLoading.set(false); this.qaError.set(adminErrorMessage(error)); },
    });
  }

  closeReceive(): void {
    if (this.qaSubmitting()) return;
    this.receiveRequest.unsubscribe(); this.receiveTarget.set(null);
  }

  setQaResult(event: Event): void {
    this.qaResult.set((event.target as HTMLSelectElement).value);
  }

  setQaQty(event: Event): void {
    this.qaQty.set((event.target as HTMLInputElement).value);
  }

  setQaItemId(event: Event): void {
    this.qaItemId.set((event.target as HTMLInputElement).value.trim());
  }

  /** Records quantity actually received for one registered line. */
  setQaLineQuantity(orderItemId: string, event: Event): void {
    const receivedQuantity = (event.target as HTMLInputElement).value;
    this.qaLines.update((lines) => lines.map((line) => line.orderItemId === orderItemId ? { ...line, receivedQuantity } : line));
  }
  /** Confirms the physical line ID for warehouse reconciliation. */
  setQaLineId(orderItemId: string, event: Event): void {
    const confirmedItemId = (event.target as HTMLInputElement).value.trim();
    this.qaLines.update((lines) => lines.map((line) => line.orderItemId === orderItemId ? { ...line, confirmedItemId } : line));
  }
  /** Records physical product matching for one line. */
  setQaLineMatch(orderItemId: string, event: Event): void {
    const matchesProduct = (event.target as HTMLInputElement).checked;
    this.qaLines.update((lines) => lines.map((line) => line.orderItemId === orderItemId ? { ...line, matchesProduct } : line));
  }
  onQaProof(event: Event): void {
    this.qaProof.set('');
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !file.type.startsWith('image/')) { this.qaError.set('Chọn một ảnh minh chứng.'); return; }
    if (file.size > 5 * 1024 * 1024) { this.qaError.set('Ảnh minh chứng tối đa 5 MB.'); return; }
    const returnId = this.receiveTarget()?.return_id, reader = new FileReader();
    reader.onload = () => { if (this.receiveTarget()?.return_id === returnId) this.qaProof.set(String(reader.result || '')); };
    reader.readAsDataURL(file);
  }

  /**
   * Chỉ chuyển sang nhận hàng hoàn trả thành công khi QA đúng hàng và có ảnh.
   */
  confirmReceive(): void {
    if (!this.qaReady() || this.qaSubmitting() || !this.canMutate()) return;
    const row = this.receiveTarget();
    if (!row || row.version == null) { this.qaError.set('Thiếu phiên bản phiếu để thao tác.'); return; }
    if (row.status !== 'RETURN_IN_TRANSIT') { this.qaError.set('Chỉ kiểm nhận khi hàng trả đang vận chuyển.'); return; }
    const lines = this.qaLines();
    if (this.qaResult() !== 'qa_pass' || lines.some((line) => !line.matchesProduct || line.confirmedItemId !== line.orderItemId || Number(line.receivedQuantity) !== line.expectedQuantity)) { this.qaError.set('Đối chiếu từng dòng: đúng mã, đủ số lượng và đúng sản phẩm của shop.'); return; }
    if (!this.qaProof().startsWith('data:image/')) { this.qaError.set('Tải ảnh minh chứng đã kiểm hàng.'); return; }
    this.qaSubmitting.set(true);
    this.api.updateReturnStatus(row.return_id, { status: 'RECEIVED', expectedVersion: row.version, conditionCheckResult: 'qa_pass', imageProof: this.qaProof(), items: lines.map((line) => ({ orderItemId: line.orderItemId, receivedQuantity: Number(line.receivedQuantity), matchesProduct: line.matchesProduct })) }).pipe(finalize(() => this.qaSubmitting.set(false))).subscribe({
      next: () => { this.receiveTarget.set(null); this.reload(); }, error: (error: unknown) => this.qaError.set(adminErrorMessage(error)),
    });
  }

  /** Routes mismatched warehouse evidence to CSKH without completing receipt/refund. */
  reportQaFailure(): void {
    const row = this.receiveTarget();
    if (!row || row.version == null || row.status !== 'RETURN_IN_TRANSIT' || !this.canMutate() || this.qaSubmitting() || !this.qaReady()) return;
    if (this.qaResult() !== 'qa_fail' || !this.qaProof().startsWith('data:image/') || this.qaFailureNote().trim().length < 10) {
      this.qaError.set('Ghi rõ sai lệch ít nhất 10 ký tự, chọn kết quả không đạt và tải ảnh kho.'); return;
    }
    this.qaSubmitting.set(true);
    this.api.updateReturnStatus(row.return_id, { status: 'NEEDS_SUPPORT', expectedVersion: row.version, conditionCheckResult: 'qa_fail', imageProof: this.qaProof(), reason: this.qaFailureNote().trim() }).pipe(finalize(() => this.qaSubmitting.set(false))).subscribe({
      next: () => { this.receiveTarget.set(null); this.reload(); }, error: (error: unknown) => this.qaError.set(adminErrorMessage(error)),
    });
  }

  /** Captures the warehouse discrepancy for operator follow-up. */
  setQaFailureNote(event: Event): void {
    this.qaFailureNote.set((event.target as HTMLTextAreaElement).value);
  }

  advanceReturn(row: AdminReturnRow, status: string): void {
    if (this.submitting()) return;
    if (!this.canMutate() || row.version == null) { this.actionError.set('Thiếu quyền hoặc phiên bản phiếu để thao tác.'); return; }
    if (this.nextReturnStep(row)?.status !== status) { this.actionError.set('Bước xử lý không hợp lệ. Mở lại phiếu để kiểm tra.'); return; }
    if (status === 'RECEIVED') { this.openReceive(row); return; }
    if (status === 'RETURN_IN_TRANSIT' || status === 'EXCHANGE_SHIPPING') {
      this.shipmentTarget.set({ row, status }); this.shipmentTracking.set(''); this.shipmentError.set(null); return;
    }
    this.submitting.set(true);
    this.api.updateReturnStatus(row.return_id, { status, expectedVersion: row.version }).pipe(finalize(() => this.submitting.set(false))).subscribe({ next: () => this.reload(), error: (error: unknown) => this.loadError.set(adminErrorMessage(error)) });
  }

  /** Records a physical shipment; each return/replacement leg has its own tracking. */
  submitShipment(event: Event): void {
    event.preventDefault();
    const target = this.shipmentTarget(), form = event.target as HTMLFormElement;
    const trackingReturnCode = (form.elements.namedItem('tracking') as HTMLInputElement | null)?.value.trim() || '';
    if (!target || this.submitting() || !this.canMutate() || target.row.version == null) return;
    if (!trackingReturnCode) { this.shipmentError.set('Nhập mã vận đơn thực tế của lần gửi hàng này.'); return; }
    this.submitting.set(true);
    this.api.updateReturnStatus(target.row.return_id, { status: target.status, trackingReturnCode, expectedVersion: target.row.version }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => { this.shipmentTarget.set(null); this.returnDetailOpen.set(false); this.reload(); },
      error: (error: unknown) => this.shipmentError.set(adminErrorMessage(error)),
    });
  }

  /** Allows recorded transfer evidence only for captured payments outside Stripe. */
  canRecordManualRefund(row: AdminReturnRow): boolean {
    return this.canMutate() && row.status === 'RECEIVED' && row.condition_check_result === 'qa_pass' && row.payment?.payment_status === 'paid' && row.payment.payment_provider !== 'stripe' && (row.return_type === 'refund' || row.request_type === 'refund');
  }

  /** Starts transfer evidence recording after warehouse QA. */
  openManualRefund(row: AdminReturnRow): void {
    if (!this.canRecordManualRefund(row)) return;
    this.manualRefundTarget.set(row); this.manualRefundProof.set(''); this.actionError.set(null);
  }

  /** Reads image evidence without assuming the transaction succeeded. */
  onManualRefundProof(event: Event): void {
    this.manualRefundProof.set('');
    const file = (event.target as HTMLInputElement).files?.[0], returnId = this.manualRefundTarget()?.return_id;
    if (!file?.type.startsWith('image/') || file.size > 5 * 1024 * 1024) { this.actionError.set('Chọn ảnh giao dịch tối đa 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { if (this.manualRefundTarget()?.return_id === returnId) this.manualRefundProof.set(String(reader.result || '')); };
    reader.readAsDataURL(file);
  }

  /** Records transfer evidence once; the server calculates the net refund amount. */
  submitManualRefund(event: Event): void {
    event.preventDefault();
    const row = this.manualRefundTarget(), form = event.target as HTMLFormElement;
    if (!row || !this.canRecordManualRefund(row) || this.submitting() || row.version == null) return;
    const transferReference = (form.elements.namedItem('reference') as HTMLInputElement | null)?.value.trim() || '';
    const adminNote = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value.trim() || '';
    if (!transferReference || adminNote.length < 10 || !this.manualRefundProof().startsWith('data:image/')) { this.actionError.set('Nhập mã giao dịch, ghi chú ít nhất 10 ký tự và ảnh chuyển tiền thành công.'); return; }
    this.submitting.set(true);
    this.api.recordManualRefund(row.return_id, { expectedVersion: row.version, transferReference, adminNote, imageProof: this.manualRefundProof() }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => { this.manualRefundTarget.set(null); this.returnDetailOpen.set(false); this.reload(); }, error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /** Nhãn kết quả QA kho. */
  qaLabel(code: string | undefined): string {
    if (code === 'qa_pass') return 'Đúng hàng của shop';
    if (code === 'qa_fail') return 'Không đúng hàng của shop';
    return 'Chưa kiểm định';
  }

  /** Nhãn trạng thái phiếu đổi/trả. */
  returnStatusLabel(status: string | undefined): string {
    return statusLabelFrom(RETURN_STATUS_LABELS, status);
  }

  /**
   * Phương thức thanh toán của đơn gắn với phiếu đổi trả.
   */
  returnPaymentMethod(row: AdminReturnRow): string {
    const provider = row.payment?.payment_provider;
    const method = row.payment?.payment_method;
    if (provider === 'stripe') return 'Stripe (Thẻ quốc tế)';
    if (method === 'COD') return 'COD (Tiền mặt)';
    if (method === 'ONLINE_PAYMENT') return 'Thanh toán Online';
    return method || '—';
  }

  /**
   * Nhãn trạng thái thanh toán và hoàn tiền của đơn.
   */
  returnPaymentStatus(row: AdminReturnRow): string {
    const status = row.payment?.payment_status;
    if (status === 'refunded') return 'Đã hoàn tiền (Stripe)';
    if (status === 'refund_pending') return 'Chờ Stripe xử lý';
    if (status === 'paid') return 'Đã thanh toán (Chưa hoàn)';
    if (status === 'pending') return 'Chờ thanh toán';
    if (status === 'failed') return 'Thanh toán thất bại';
    return status || '—';
  }

  isReturnRefunded(row: AdminReturnRow): boolean {
    return row.payment?.payment_status === 'refunded';
  }

  canTriggerStripeRefund(row: AdminReturnRow): boolean {
    return this.canMutate() && row.payment?.payment_provider === 'stripe' && row.payment?.payment_status !== 'refunded' && ['RECEIVED', 'REFUND_PROCESSING'].includes(row.status || '') && row.condition_check_result === 'qa_pass' && row.version != null && (row.return_type === 'refund' || row.request_type === 'refund');
  }

  triggerStripeRefund(row: AdminReturnRow): void {
    if (!this.canTriggerStripeRefund(row) || this.submitting()) return;
    this.submitting.set(true); this.actionError.set(null);
    this.api.triggerStripeRefund(row.return_id, { expectedVersion: row.version }).pipe(finalize(() => this.submitting.set(false))).subscribe({ next: () => { this.openReturnDetail(row.return_id); this.reload(); }, error: (error: unknown) => this.actionError.set(adminErrorMessage(error)) });
  }

  /** Nhãn trạng thái phiếu hỗ trợ. */
  ticketStatusLabel(status: string | undefined): string {
    return statusLabelFrom(TICKET_STATUS_LABELS, status);
  }

  /**
   * Nhãn trạng thái đơn hàng.
   *
   * Màn tra cứu đơn trước đây đọc bằng bảng nhãn đổi trả, nên `confirmed`, `shipping`,
   * `delivered` rơi ra tiếng Anh, còn `pending` hiện "Chờ xử lý" trong khi trang Đơn
   * hàng gọi đúng trạng thái đó là "Chờ xác nhận".
   */
  orderStatusLabel(status: string | undefined): string {
    return statusLabelFrom(ORDER_STATUS_LABELS, status);
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
    if (type === 'resolve') {
      return 'Đánh dấu đã giải quyết';
    }
    return 'Đóng phiếu hỗ trợ';
  }
}
