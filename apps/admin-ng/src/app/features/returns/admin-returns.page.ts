import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminChatMessageRow,
  AdminChatSessionRow,
  AdminReturnRow,
  AdminTicketRow,
} from '../../core/admin-api.service';
import { adminDateTime } from '../../core/admin-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type ServiceZone = 'chat' | 'returns' | 'support' | 'logs';
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
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-returns.page.html',
})
export class AdminReturnsPage {
  private readonly api = inject(AdminApiService);

  readonly zone = signal<ServiceZone>('chat');
  readonly returns = signal<AdminReturnRow[]>([]);
  readonly tickets = signal<AdminTicketRow[]>([]);
  readonly chats = signal<AdminChatSessionRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly messages = signal<AdminChatMessageRow[]>([]);
  readonly loadError = signal<string | null>(null);
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

  readonly pendingReturns = computed(() =>
    this.returns().filter((row) => {
      if (row.status !== 'pending') {
        return false;
      }
      const age = (Date.now() - new Date(row.created_at || 0).getTime()) / 36e5;
      return age <= 48;
    }).length,
  );
  readonly pendingTickets = computed(() => this.tickets().filter((row) => !['resolved', 'closed'].includes(row.status || '')).length);
  readonly highPriority = computed(() => {
    const tickets = this.tickets().filter((row) => row.priority === 'high' && !['resolved', 'closed'].includes(row.status || '')).length;
    return tickets + this.pendingReturns();
  });
  readonly completedToday = computed(() => this.returns().filter((row) => row.status === 'completed' || row.status === 'resolved').length);
  readonly pagedReturns = computed(() => this.slicePage(this.returns()));
  readonly pagedTickets = computed(() => this.slicePage(this.tickets()));
  readonly pagedLogs = computed(() => this.slicePage(this.logs()));
  readonly returnPageCount = computed(() => Math.max(1, Math.ceil(this.returns().length / this.pageSize)));
  readonly ticketPageCount = computed(() => Math.max(1, Math.ceil(this.tickets().length / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logs().length / this.pageSize)));
  readonly returnRange = computed(() => this.rangeText(this.returns().length, 'phiếu'));
  readonly ticketRange = computed(() => this.rangeText(this.tickets().length, 'phiếu'));
  readonly logRange = computed(() => this.rangeText(this.logs().length, 'nhật ký'));
  readonly visibleChats = computed(() => {
    const filter = this.chatFilter();
    return this.chats().filter((session) => {
      if (session.is_active === false) {
        return false;
      }
      if (filter === 'all') {
        return true;
      }
      return (session.handoff_status || 'ai') === filter;
    });
  });
  readonly pendingChatCount = computed(() => this.chats().filter((session) => session.handoff_status === 'requested').length);
  readonly canReply = computed(() => this.selectedChat()?.handoff_status === 'assigned');
  readonly canJoinChat = computed(() => {
    const status = this.selectedChat()?.handoff_status || 'ai';
    return status === 'ai' || status === 'requested';
  });
  readonly isClosedChat = computed(() => this.selectedChat()?.handoff_status === 'closed');

  constructor() {
    this.reload();
  }

  /**
   * Reloads returns, tickets, chats, and service logs.
   */
  reload(): void {
    this.loadError.set(null);
    forkJoin({
      returns: this.api.listReturns({ limit: '200' }).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error));
          return of({ rows: [] as AdminReturnRow[] });
        }),
      ),
      tickets: this.api.listTickets({ limit: '200' }).pipe(catchError(() => of({ rows: [] as AdminTicketRow[] }))),
      chats: this.api.listChatSessions({ limit: '1000', handoffOnly: 'false' }).pipe(catchError(() => of({ rows: [] as AdminChatSessionRow[] }))),
      logs: this.api.listServiceLogs({ limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminAuditRow[] }))),
    }).subscribe((payload) => {
      this.returns.set(adminListRows(payload.returns));
      this.tickets.set(adminListRows(payload.tickets));
      this.chats.set(adminListRows(payload.chats).filter((session) => session.is_active !== false));
      const selectedId = this.selectedChat()?.session_id;
      if (selectedId) {
        const next = this.chats().find((session) => session.session_id === selectedId) || null;
        this.selectedChat.set(next);
      }
      this.logs.set(adminListRows(payload.logs));
    });
  }

  /**
   * Switches the original CSKH workspace tabs.
   */
  setZone(zone: ServiceZone): void {
    this.zone.set(zone);
    this.page.set(1);
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
   * Filters the original chat session list.
   */
  onChatFilter(event: Event): void {
    this.chatFilter.set((event.target as HTMLSelectElement).value || 'all');
  }

  /**
   * Assigns the selected chat session to the current admin.
   */
  assignChat(): void {
    const session = this.selectedChat();
    if (!session) {
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
    if (!session) {
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
    if (!session || !message) {
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
    this.selectedReturn.set(this.returns().find((row) => row.return_id === returnId) || null);
    this.selectedTicket.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
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

  private slicePage<T>(rows: T[]): T[] {
    const start = (this.page() - 1) * this.pageSize;
    return rows.slice(start, start + this.pageSize);
  }

  private rangeText(total: number, noun: string): string {
    if (!total) {
      return `Hiển thị 0 - 0 / 0 ${noun}`;
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} ${noun}`;
  }
}
