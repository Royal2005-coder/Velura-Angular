import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminDialogDirective } from '../../shared/admin-dialog.directive';
import { finalize } from 'rxjs';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
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
import { AdminChatReviewService, type AdminChatClassification, type AdminChatOriginal, type AdminChatReviewInput, type AdminReviewedChatMessage, type AdminReviewedChatSession } from '../../core/admin-chat-review.service';

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

/**
 * Nén ảnh bằng HTML5 Canvas để tránh vượt ngưỡng payload của API và Vercel Serverless.
 * Giới hạn cạnh dài nhất tối đa 1280px, chất lượng JPEG 0.82 (dung lượng thường < 150KB).
 */
function compressImageFile(file: File, maxDimension = 1280, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve('');
    reader.onload = () => {
      const rawDataUrl = String(reader.result || '');
      if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Image === 'undefined') {
        resolve(rawDataUrl);
        return;
      }
      try {
        const img = new Image();
        img.onerror = () => resolve(rawDataUrl);
        img.onload = () => {
          try {
            let width = img.naturalWidth || img.width;
            let height = img.naturalHeight || img.height;
            if (!width || !height) {
              resolve(rawDataUrl);
              return;
            }
            if (width > maxDimension || height > maxDimension) {
              if (width > height) {
                height = Math.round((height * maxDimension) / width);
                width = maxDimension;
              } else {
                width = Math.round((width * maxDimension) / height);
                height = maxDimension;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(rawDataUrl);
              return;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch {
            resolve(rawDataUrl);
          }
        };
        img.src = rawDataUrl;
      } catch {
        resolve(rawDataUrl);
      }
    };
    reader.readAsDataURL(file);
  });
}

@Component({
  selector: 'app-admin-returns-page',
  imports: [AdminDialogDirective, AdminEmptyState, AdminIcon, AdminPagination, RouterLink],
  templateUrl: './admin-returns.page.html',
})
export class AdminReturnsPage {
  private listRequest = new Subscription();
  private messageRequest = new Subscription();
  private chatReviewRequest = new Subscription();
  private chatOriginalRequest = new Subscription();
  private receiveRequest = new Subscription();
  private returnDetailRequest = new Subscription();
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);
  private readonly chatReview = inject(AdminChatReviewService);
  private readonly route = inject(ActivatedRoute);

  readonly zone = signal<ServiceZone>('chat');
  readonly returns = signal<AdminReturnRow[]>([]);
  readonly tickets = signal<AdminTicketRow[]>([]);
  readonly orders = signal<AdminOrderRow[]>([]);
  readonly chats = signal<AdminChatSessionRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly messages = signal<AdminReviewedChatMessage[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly chatLoading = signal(false);
  readonly submitting = signal(false);
  readonly qaLoading = signal(false);
  readonly qaSubmitting = signal(false);
  readonly qaLines = signal<ReceiptLine[]>([]);
  readonly qaReady = computed(() => !this.qaLoading() && this.qaLines().length > 0);
  readonly selectedChat = signal<AdminReviewedChatSession | null>(null);
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
  readonly chatReviewOpen = signal(false);
  readonly chatReviewTarget = signal<AdminReviewedChatMessage | null>(null);
  readonly chatReviewAction = signal<AdminChatReviewInput['action']>('outcome');
  readonly chatReviewNote = signal('');
  readonly summaryProblem = signal('');
  readonly summaryWanted = signal('');
  readonly summaryFailed = signal('');
  readonly finalSentiment = signal<'positive' | 'neutral' | 'negative'>('neutral');
  readonly selectedOfferId = signal('');
  readonly correctedText = signal('');
  private reportSessionId = '';
  private reviewSourceSequence: number | undefined;
  readonly chatReviewRisk = signal<'yellow' | 'orange' | 'red'>('orange');
  readonly chatReviewConfirmed = signal(false);
  readonly chatReviewBusy = signal(false);
  readonly chatReviewError = signal<string | null>(null);
  readonly chatReviewFeedback = signal<string | null>(null);
  readonly chatOriginalConfirmed = signal(false);
  readonly chatOriginalBusy = signal(false);
  readonly chatOriginal = signal<AdminChatOriginal | null>(null);
  readonly chatReviewClassification = signal<AdminChatClassification>({ intent: 'facts', level: 'L0', issue: 'general', sentiment: 'neutral', risk: 'green', moderation: 'none' });
  readonly chatClassificationFields = ['intent', 'level', 'issue', 'sentiment', 'risk', 'moderation'] as const;
  readonly chatClassificationLabels = { intent: 'Ý định', level: 'Cấp xử lý', issue: 'Vấn đề', sentiment: 'Cảm xúc', risk: 'Rủi ro', moderation: 'Loại nội dung' };
  readonly chatClassificationOptions: Record<keyof AdminChatClassification, readonly { value: string; label: string }[]> = {
    intent: [{ value: 'facts', label: 'Thông tin' }, { value: 'catalog', label: 'Sản phẩm' }, { value: 'policy_problem', label: 'Giải quyết theo chính sách' }, { value: 'order', label: 'Đơn hàng' }, { value: 'human', label: 'Yêu cầu nhân viên' }],
    level: [{ value: 'L0', label: 'L0 · Thông tin chính thức' }, { value: 'L1', label: 'L1 · Tư vấn sản phẩm' }, { value: 'L2', label: 'L2 · Chính sách đã duyệt' }, { value: 'L3', label: 'L3 · Nhân viên' }],
    issue: [{ value: 'general', label: 'Chung' }, { value: 'catalog', label: 'Sản phẩm' }, { value: 'sizing', label: 'Kích cỡ' }, { value: 'delivery', label: 'Giao hàng' }, { value: 'return', label: 'Đổi trả' }, { value: 'payment', label: 'Thanh toán' }, { value: 'cancellation', label: 'Hủy đơn' }],
    sentiment: [{ value: 'positive', label: 'Tích cực' }, { value: 'neutral', label: 'Trung tính' }, { value: 'negative', label: 'Tiêu cực' }],
    risk: [{ value: 'green', label: 'Xanh · Bình thường' }, { value: 'yellow', label: 'Vàng · Cần chú ý' }, { value: 'orange', label: 'Cam · Cần kiểm duyệt' }, { value: 'red', label: 'Đỏ · Cần giám sát' }],
    moderation: [{ value: 'none', label: 'Không vi phạm' }, { value: 'abuse', label: 'Lăng mạ / quấy rối' }, { value: 'threat', label: 'Đe dọa' }, { value: 'illegal', label: 'Nội dung bất hợp pháp' }, { value: 'sensitive', label: 'Nội dung nhạy cảm' }],
  };
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
  readonly fixedRefundAmount = computed(() => {
    const row = this.selectedReturn();
    const suggestion = this.refundSuggestion();
    if (suggestion != null && suggestion > 0) {
      return suggestion;
    }
    const fallback = Number(row?.refundable_amount ?? row?.refund_amount ?? row?.order_total ?? 0);
    return fallback > 0 ? fallback : 0;
  });
  readonly contactTarget = signal<AdminReturnRow | null>(null);
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

  readonly searchQuery = signal('');
  readonly statusFilter = signal('');
  readonly typeFilter = signal('');
  readonly returnTab = signal<'all' | 'attention' | 'warehouse' | 'refund' | 'completed'>('all');
  readonly menuId = signal<string | null>(null);

  readonly pendingReturns = computed(() => this.pendingReturnCount());
  readonly pendingTickets = computed(() => this.pendingTicketCount());
  readonly highPriority = computed(() => this.pendingReturnCount() + this.pendingTicketCount());
  readonly completedToday = computed(() => this.completedReturnCount());
  readonly filteredReturns = computed(() => {
    let list = this.returns();
    const tab = this.returnTab();
    if (tab === 'attention') {
      list = list.filter((r) => ['REQUESTED', 'CONTACTING', 'NEEDS_SUPPORT'].includes(r.status || ''));
    } else if (tab === 'warehouse') {
      list = list.filter((r) => ['WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED'].includes(r.status || ''));
    } else if (tab === 'refund') {
      list = list.filter((r) => ['REFUND_PROCESSING'].includes(r.status || ''));
    } else if (tab === 'completed') {
      list = list.filter((r) => ['COMPLETED', 'REFUNDED'].includes(r.status || ''));
    }
    const status = this.statusFilter();
    if (status) {
      list = list.filter((r) => r.status === status);
    }
    const type = this.typeFilter();
    if (type) {
      list = list.filter((r) => (r.return_type || r.request_type) === type);
    }
    const q = this.searchQuery().trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const retId = (r.return_id || '').toLowerCase();
        const code = (this.returnCode(r) || '').toLowerCase();
        const ordCode = (this.orderCode(r) || '').toLowerCase();
        const ordId = (r.order_id || '').toLowerCase();
        const name = (r.customer_name || '').toLowerCase();
        const phone = (r.customer_phone || '').toLowerCase();
        const track = (r.tracking_return_code || '').toLowerCase();
        return retId.includes(q) || code.includes(q) || ordCode.includes(q) || ordId.includes(q) || name.includes(q) || phone.includes(q) || track.includes(q);
      });
    }
    return list;
  });

  readonly attentionReturnsCount = computed(() => this.returns().filter((r) => ['REQUESTED', 'CONTACTING', 'NEEDS_SUPPORT'].includes(r.status || '')).length);
  readonly warehouseReturnsCount = computed(() => this.returns().filter((r) => ['WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED'].includes(r.status || '')).length);
  readonly refundProcessingCount = computed(() => this.returns().filter((r) => ['REFUND_PROCESSING'].includes(r.status || '')).length);
  readonly completedReturnsCount = computed(() => this.returns().filter((r) => ['COMPLETED', 'REFUNDED'].includes(r.status || '')).length);

  readonly pagedReturns = computed(() => this.filteredReturns());
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
  readonly isChatSupervisor = computed(() => this.canMutate() && this.session.session()?.roleCode === 'super_admin' && this.session.session()?.isActive === true);
  readonly canHandleChat = computed(() => !this.selectedChat()?.metadata?.supervisor_required || this.isChatSupervisor());
  readonly canReply = computed(() => this.canMutate() && this.canHandleChat() && !this.isClosedChat() && (!this.selectedChat()?.assigned_to || this.selectedChat()?.assigned_to === this.session.session()?.id));
  readonly canJoinChat = computed(() => {
    if (!this.canMutate() || !this.canHandleChat()) {
      return false;
    }
    if (this.selectedChat()?.assigned_to && this.selectedChat()?.assigned_to !== this.session.session()?.id) return false;
    const status = this.selectedChat()?.handoff_status || 'ai';
    return status === 'ai' || status === 'requested';
  });
  readonly isClosedChat = computed(() => this.selectedChat()?.handoff_status === 'closed');

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.messageRequest.unsubscribe(); this.receiveRequest.unsubscribe(); this.returnDetailRequest.unsubscribe(); this.clearChatReview(); });
    inject(DestroyRef).onDestroy(() => this.listRequest.unsubscribe());
    inject(AdminRefreshService).register(() => {
      if (!this.loading() && !this.submitting() && !this.actionType() && !this.receiveTarget() && !this.shipmentTarget() && !this.manualRefundTarget() && !this.contactTarget()) this.reload();
    }, inject(DestroyRef));
    this.reportSessionId = this.route.snapshot.queryParamMap.get('sessionId') || this.route.snapshot.queryParamMap.get('session') || '';
    this.reload();
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const id = params.get('sessionId') || params.get('session');
      if (id && id !== this.selectedChat()?.session_id) {
        this.zone.set('chat'); this.selectChat(this.chats().find(session => session.session_id === id) || { session_id: id });
      }
    });
  }

  /**
   * Reloads the active CSKH zone from server-paged APIs.
   */
  reload(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const pageParams: Record<string, string> = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };
    const zone = this.zone();
    if (zone === 'returns') {
      const q = this.searchQuery().trim();
      if (q) pageParams['q'] = q;
      const status = this.statusFilter();
      if (status) pageParams['status'] = status;
    }
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
        const next = this.chats().find((session) => session.session_id === selectedId);
        if (next) this.selectedChat.set(next);
      } else if (this.reportSessionId) {
        const id = this.reportSessionId; this.reportSessionId = '';
        this.selectChat(this.chats().find(session => session.session_id === id) || { session_id: id });
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
    if (zone !== 'chat') this.clearChatReview();
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
    this.clearChatReview();
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
        if (this.chatReviewOpen() && payload.session?.metadata?.intelligence?.source_seq !== this.reviewSourceSequence) {
          this.chatReviewConfirmed.set(false);
          this.chatReviewError.set('Ngữ cảnh đã cập nhật. Rà soát lại nội dung trước khi xác nhận.');
        }
        if (payload.session) this.selectedChat.set(payload.session);
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
    this.api.assignChatSession(session.session_id).pipe(finalize(() => this.submitting.set(false))).subscribe({
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
   * Opens outcome review; closing requires a resolution, final sentiment and explicit confirmation.
   */
  closeChat(): void {
    if (!this.canReply() || this.submitting()) return;
    this.openChatReview(); this.chatReviewAction.set('resolve');
  }

  /**
   * Claims an unowned case before submitting a staff turn to the continuous filtering pipeline.
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
      this.api.assignChatSession(session.session_id).subscribe({
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

  /** Localized labels explain the stored model classification without exposing private context. */
  chatClassificationLabel(field: keyof AdminChatClassification, value: string): string {
    const option = this.chatClassificationOptions[field].find((item) => item.value === value);
    return option?.label || 'Chưa phân loại';
  }

  /** Opens human review without fetching a restricted original or changing model/account behavior. */
  openChatReview(message: AdminReviewedChatMessage | null = null): void {
    if (!this.selectedChat() || !this.canMutate() || this.chatReviewBusy()) return;
    this.clearChatReview();
    this.chatReviewTarget.set(message);
    this.chatReviewAction.set(message?.moderation_status === 'pending' ? 'refilter' : message ? 'correction' : 'outcome');
    if (message?.metadata?.classification) this.chatReviewClassification.set({ ...message.metadata.classification });
    this.chatReviewOpen.set(true);
    this.reviewSourceSequence = this.selectedChat()?.metadata?.intelligence?.source_seq;
    const summary = this.selectedChat()?.metadata?.handoff_summary;
    this.summaryProblem.set(summary?.problem || summary?.summary || '');
    this.summaryWanted.set(summary?.wanted || '');
    this.summaryFailed.set((summary?.failed_approaches || []).join('\n'));
  }

  /** Discards local review/original state; an in-flight write must finish before user dismissal. */
  closeChatReview(): void {
    if (this.chatReviewBusy()) return;
    this.clearChatReview();
  }

  private clearChatReview(): void {
    this.chatReviewRequest.unsubscribe(); this.chatOriginalRequest.unsubscribe();
    this.chatReviewOpen.set(false); this.chatReviewTarget.set(null); this.chatOriginal.set(null);
    this.chatReviewBusy.set(false); this.chatOriginalBusy.set(false);
    this.chatReviewConfirmed.set(false); this.chatOriginalConfirmed.set(false);
    this.chatReviewNote.set(''); this.chatReviewError.set(null); this.chatReviewFeedback.set(null);
    this.selectedOfferId.set(''); this.summaryProblem.set(''); this.summaryWanted.set(''); this.summaryFailed.set('');
    this.correctedText.set('');
    this.chatReviewClassification.set({ intent: 'facts', level: 'L0', issue: 'general', sentiment: 'neutral', risk: 'green', moderation: 'none' });
  }

  /** Selects an audited review action and requires a new confirmation before submission. */
  onChatReviewAction(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!['correction', 'outcome', 'supervisor', 'moderate', 'refilter', 'summary', 'resolve', 'reopen', 'offer', 'report_retry'].includes(value)) return;
    this.chatReviewAction.set(value as AdminChatReviewInput['action']);
    this.chatReviewConfirmed.set(false); this.chatReviewError.set(null);
  }

  /** Accepts only an official classification label, preserving all other review fields. */
  setChatClassification(field: keyof AdminChatClassification, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!this.chatClassificationOptions[field].some((option) => option.value === value)) return;
    this.chatReviewClassification.update((classification) => ({ ...classification, [field]: value }));
    this.chatReviewConfirmed.set(false);
  }

  /** Updates the human audit note without persisting or training on it automatically. */
  onChatReviewNote(event: Event): void {
    this.chatReviewNote.set((event.target as HTMLTextAreaElement).value);
    this.chatReviewConfirmed.set(false);
  }

  /** Records the moderation severity selected by staff; it never locks an account. */
  onChatReviewRisk(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== 'yellow' && value !== 'orange' && value !== 'red') return;
    this.chatReviewRisk.set(value); this.chatReviewConfirmed.set(false);
  }

  /** Records the staff member's explicit confirmation of the visible review action. */
  confirmChatReview(event: Event): void {
    this.chatReviewConfirmed.set((event.target as HTMLInputElement).checked);
    if (this.chatReviewConfirmed()) this.reviewSourceSequence = this.selectedChat()?.metadata?.intelligence?.source_seq;
  }

  /** Records acknowledgement that original-content access is privileged and audited. */
  confirmChatOriginal(event: Event): void {
    this.chatOriginalConfirmed.set((event.target as HTMLInputElement).checked);
    if (!this.chatOriginalConfirmed()) {
      this.chatOriginalRequest.unsubscribe(); this.chatOriginal.set(null); this.chatOriginalBusy.set(false);
    }
  }

  /** Sends a complete human review; failures retain the note and do not claim a saved correction. */
  saveChatReview(event: Event): void {
    event.preventDefault();
    const session = this.selectedChat(), target = this.chatReviewTarget(), action = this.chatReviewAction();
    if (!session || !this.canMutate() || !this.canHandleChat() || this.chatReviewBusy()) return;
    const text = this.chatReviewNote().trim();
    if (!text || text.length > 2000 || !this.chatReviewConfirmed() || (['correction', 'moderate', 'refilter'].includes(action) && !target?.message_id)) {
      this.chatReviewError.set('Chọn tin nhắn khi cần, nhập ghi chú và xác nhận thao tác trước khi lưu.'); return;
    }
    const body: AdminChatReviewInput = { action, text, confirmed: true, ...(target?.message_id ? { messageId: target.message_id } : {}) };
    if (action === 'correction') body.classification = { ...this.chatReviewClassification() };
    if (action === 'correction' && this.isChatSupervisor() && this.correctedText().trim()) body.filteredText = this.correctedText().trim();
    if (action === 'moderate') { body.risk = this.chatReviewRisk(); body.confirmed = true; }
    if (action === 'summary') {
      if (!this.summaryProblem().trim() || !this.summaryWanted().trim()) { this.chatReviewError.set('Nhập vấn đề và mong muốn đã xác minh.'); return; }
      body.summary = { problem: this.summaryProblem().trim(), wanted: this.summaryWanted().trim(), failed_approaches: this.summaryFailed().split('\n').map(value => value.trim()).filter(Boolean) };
    }
    if (action === 'resolve') body.outcome = { resolution: text, finalSentiment: this.finalSentiment() };
    if (action === 'offer') {
      if (!session.metadata?.eligible_offers?.some(offer => offer.offer_id === this.selectedOfferId())) { this.chatReviewError.set('Chọn ưu đãi đủ điều kiện đã được duyệt.'); return; }
      body.offerId = this.selectedOfferId();
    }
    if (action === 'report_retry') {
      if (!session.metadata?.report_status?.report_id) { this.chatReviewError.set('Chưa có báo cáo để gửi lại.'); return; }
      body.reportId = session.metadata.report_status.report_id;
    }
    this.chatReviewBusy.set(true); this.chatReviewError.set(null); this.chatReviewFeedback.set(null);
    this.chatReviewRequest = this.chatReview.review(session.session_id, body).pipe(finalize(() => this.chatReviewBusy.set(false))).subscribe({
      next: (payload) => {
        if (this.selectedChat()?.session_id !== session.session_id || !this.chatReviewOpen()) return;
        if (payload.session) this.selectedChat.set(payload.session);
        this.chatReviewConfirmed.set(false); this.chatReviewNote.set('');
        this.chatReviewFeedback.set(action === 'report_retry' ? 'Đã ghi nhận yêu cầu gửi lại. Xem trạng thái báo cáo để biết kết quả.' : 'Đã lưu quyết định và cập nhật trạng thái phiên. Không tự động huấn luyện AI.');
        this.loadChatMessages(session.session_id);
      },
      error: (error: unknown) => { if (this.selectedChat()?.session_id === session.session_id) this.chatReviewError.set(adminErrorMessage(error, 'Không lưu được nhật ký rà soát.')); },
    });
  }

  /** Fetches an original only after supervisor confirmation; session changes discard late private data. */
  viewChatOriginal(): void {
    const session = this.selectedChat(), target = this.chatReviewTarget();
    if (!session || !target?.message_id || !this.isChatSupervisor() || !this.chatOriginalConfirmed() || this.chatOriginalBusy() || !(target.moderation_status === 'restricted' || target.metadata?.moderated)) return;
    const messageId = target.message_id;
    this.chatOriginal.set(null); this.chatOriginalBusy.set(true); this.chatReviewError.set(null);
    this.chatOriginalRequest = this.chatReview.original(session.session_id, messageId).pipe(finalize(() => this.chatOriginalBusy.set(false))).subscribe({
      next: (original) => {
        if (this.selectedChat()?.session_id !== session.session_id || this.chatReviewTarget()?.message_id !== messageId || !this.chatOriginalConfirmed()) return;
        this.chatOriginal.set(original);
        this.chatReviewFeedback.set('Đã truy cập bản gốc. Lượt truy cập này được ghi vào nhật ký giám sát.');
      },
      error: (error: unknown) => { if (this.selectedChat()?.session_id === session.session_id) this.chatReviewError.set(adminErrorMessage(error, 'Không được truy cập bản gốc hoặc bản gốc không còn tồn tại.')); },
    });
  }

  /** Updates structured summary/offer drafts and invalidates the previous confirmation. */
  setChatCaseField(field: 'summaryProblem' | 'summaryWanted' | 'summaryFailed' | 'selectedOfferId' | 'correctedText', event: Event): void {
    this[field].set((event.target as HTMLInputElement).value); this.chatReviewConfirmed.set(false);
  }

  /** Records staff assessment of final customer sentiment, never defaulting an unknown live signal. */
  setFinalSentiment(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'positive' || value === 'neutral' || value === 'negative') this.finalSentiment.set(value);
    this.chatReviewConfirmed.set(false);
  }

  /** Refreshes authoritative filtered context while preserving reply and correction drafts. */
  refreshChatContext(): void { const id = this.selectedChat()?.session_id; if (id) this.loadChatMessages(id); }

  /** Missing moderation state is quarantined just like pending state; raw server text is never a fallback. */
  safeChatText(message: AdminReviewedChatMessage): string {
    if (message.moderation_status === 'pending') return 'Đang lọc nội dung. CSKH chỉ xem sau khi kiểm tra hoàn tất.';
    return message.text || '—';
  }

  /** An unprocessed customer/staff turn is not eligible for review or product rendering. */
  chatMessageReady(message: AdminReviewedChatMessage): boolean { return message.moderation_status === 'visible' || message.moderation_status === 'restricted'; }

  /** Names the exclusive case owner without pretending the viewer owns another staff member's case. */
  chatOwner(): string {
    const owner = this.selectedChat()?.assigned_to;
    return !owner ? 'Chưa tiếp nhận' : owner === this.session.session()?.id ? 'Bạn đang phụ trách' : `Nhân viên ${owner}`;
  }

  /** Shows freshness separately from confidence so stale context is never treated as current. */
  chatFreshness(): string {
    const intelligence = this.selectedChat()?.metadata?.intelligence;
    if (intelligence?.filter_status === 'outage') return 'Bộ lọc gián đoạn · Nội dung chưa kiểm tra bị giữ riêng';
    if (intelligence?.filter_status === 'pending') return 'Đang cập nhật ngữ cảnh';
    if (!intelligence?.updated_at) return 'Chưa có thời điểm phân tích';
    const age = Date.now() - Date.parse(intelligence.updated_at);
    return `${age > 120000 ? 'Ngữ cảnh cần cập nhật' : 'Ngữ cảnh mới nhất'} · ${this.date(intelligence.updated_at)}`;
  }

  /** Confidence is an estimate, not a verified business fact. */
  chatConfidence(): string {
    const value = this.selectedChat()?.metadata?.intelligence?.confidence;
    return value == null ? 'Chưa đánh giá' : `${Math.round(value <= 1 ? value * 100 : value)}%`;
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
    const initialAmount = Number(row.refundable_amount ?? row.refund_amount ?? row.order_total ?? 0);
    this.refundSuggestion.set(initialAmount > 0 ? initialAmount : null);
    if (type === 'refund') {
      // Số tiền hoàn lấy theo đúng những món khách gửi trả (API tính từ return_item),
      // không lấy tổng đơn: một đơn nhiều món mà khách chỉ trả một món thì hoàn cả đơn
      // là thất thoát.
      this.api.getReturn(returnId).subscribe({
        next: (detail) => {
          // Bỏ qua phản hồi cũ nếu CSKH đã chuyển sang phiếu khác.
          if (this.selectedReturn()?.return_id === returnId) {
            this.selectedReturn.set(detail);
            const detailAmount = Number(detail.refundable_amount ?? detail.refund_amount ?? detail.order_total ?? 0);
            if (detailAmount > 0) {
              this.refundSuggestion.set(detailAmount);
            }
          }
        },
        error: () => {
          // Giữ initialAmount nếu getReturn gặp lỗi mạng tạm thời
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
    if (row.chat_session_id) return false;
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
    const selected = this.selectedTicket();
    const ticket = selected?.ticket_id === ticketId ? selected : this.tickets().find(row => row.ticket_id === ticketId) || null;
    if (!ticket || !this.canTicketAction(ticket, type)) return;
    this.selectedTicket.set(ticket);
    this.selectedReturn.set(null);
    this.actionType.set(type);
    this.actionError.set(null);
  }

  /** Opens the linked session so replies, filtering and resolution cannot bypass chat governance. */
  openLinkedTicketChat(ticket: AdminTicketRow): void {
    if (!ticket.chat_session_id) return;
    const id = ticket.chat_session_id;
    this.closeOverlays();
    this.selectChat(this.chats().find(session => session.session_id === id) || { session_id: id });
    this.setZone('chat');
  }

  /**
   * Opens or closes the row action menu.
   */
  toggleMenu(returnId: string): void {
    this.menuId.update((current) => (current === returnId ? null : returnId));
  }

  /**
   * Closes the row action menu.
   */
  closeMenu(): void {
    this.menuId.set(null);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.menuId() && !(event.target as HTMLElement)?.closest('.admin-return-actions')) {
      this.menuId.set(null);
    }
  }

  /**
   * Opens the return request detail drawer.
   */
  openReturnDetail(returnId: string): void {
    this.menuId.set(null);
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
    this.menuId.set(null);
    this.returnDetailRequest.unsubscribe();
    this.actionType.set(null);
    this.selectedReturn.set(null);
    this.selectedTicket.set(null);
    this.actionError.set(null);
    this.refundSuggestion.set(null);
    this.returnDetailOpen.set(false);
    this.ticketDetailOpen.set(false);
    this.lightboxImage.set(null);
    this.contactTarget.set(null);
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
    const amount = type === 'refund' ? this.fixedRefundAmount() : 0;
    const ret = this.selectedReturn();
    const ticket = this.selectedTicket();
    if (ticket?.chat_session_id) {
      this.actionType.set(null);
      this.actionError.set('Phiếu liên kết hội thoại chỉ được xử lý trong Chat trực tuyến.');
      return;
    }
    if (note.length < 10) {
      this.actionError.set('Ghi rõ nội dung xử lý, tối thiểu 10 ký tự.');
      return;
    }
    if (type === 'refund' && (!Number.isFinite(amount) || amount <= 0)) {
      this.actionError.set('Không xác định được số tiền hoàn hợp lệ (> 0đ) cho phiếu này.');
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
    return session.last_message_preview || session.title || 'Hội thoại khách hàng';
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
   * Risk level badge for mental health & safety governance.
   */
  chatRiskBadge(session: AdminChatSessionRow | null | undefined): { label: string; tone: string; icon: string } {
    const raw = session?.risk_level || session?.metadata?.handoff_summary?.risk;
    if (!raw || session?.metadata?.intelligence?.filter_status !== 'ready') return { label: 'Chưa đánh giá / Chờ lọc', tone: 'neutral', icon: '—' };
    const risk = String(raw).toLowerCase();
    if (risk === 'red') return { label: 'Khẩn cấp / Cần giám sát', tone: 'danger', icon: '🔴' };
    if (risk === 'orange') return { label: 'Cảnh báo tiêu cực', tone: 'caution', icon: '🟠' };
    if (risk === 'yellow') return { label: 'Cần chú ý', tone: 'warning', icon: '🟡' };
    return risk === 'green' ? { label: 'Bình thường', tone: 'success', icon: '🟢' } : { label: 'Chưa đánh giá', tone: 'neutral', icon: '—' };
  }

  /**
   * Sentiment label for customer emotion tracking.
   */
  chatSentimentBadge(session: AdminChatSessionRow | null | undefined): { label: string; tone: string } {
    const sentiment = session?.metadata?.handoff_summary?.sentiment;
    if (sentiment === 'positive') return { label: 'Tích cực', tone: 'success' };
    if (sentiment === 'negative') return { label: 'Tiêu cực / Bức xúc', tone: 'danger' };
    return { label: sentiment === 'neutral' ? 'Trung tính' : 'Chưa đánh giá', tone: 'neutral' };
  }

  /**
   * Summary problem and wanted outcome.
   */
  chatSummaryInfo(session: AdminChatSessionRow | null | undefined) {
    const summary = session?.metadata?.handoff_summary;
    if (!summary) return null;
    return {
      problem: summary.problem || summary.summary || '',
      wanted: summary.wanted || '',
      failedApproaches: summary.failed_approaches || [],
      verifiedStatus: summary.verified_status || '',
      supervisorRequired: Boolean(session?.metadata?.supervisor_required),
    };
  }

  /**
   * Product cards attached to a chat message.
   */
  productsOf(message: AdminChatMessageRow): Array<{ product_id: string; name?: string; image_url?: string; sale_price?: number; base_price?: number }> {
    if (!this.chatMessageReady(message)) return [];
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
  messageLabel(message: AdminReviewedChatMessage): string {
    if (message.metadata?.system || message.metadata?.speaker === 'SYSTEM') return 'Hệ thống';
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
      WAITING_RETURN: { status: 'RETURN_IN_TRANSIT', label: 'Xác nhận gửi' },
      RETURN_IN_TRANSIT: { status: 'RECEIVED', label: 'Nhận hàng & QA' },
      REFUNDED: { status: 'COMPLETED', label: 'Hoàn tất' },
      EXCHANGE_PREPARING: { status: 'EXCHANGE_SHIPPING', label: 'Giao hàng đổi' },
      EXCHANGE_SHIPPING: { status: 'COMPLETED', label: 'Hoàn tất đổi' },
      NEEDS_SUPPORT: { status: 'CONTACTING', label: 'Hỗ trợ lại' },
    };
    if (row.status === 'RECEIVED' && row.condition_check_result === 'qa_pass' && (row.return_type === 'exchange' || row.request_type === 'exchange')) return { status: 'EXCHANGE_PREPARING', label: 'Soạn hàng đổi' };
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

  /**
   * Mở modal ghi nhận liên hệ khách hàng trực tiếp từ bảng hoặc drawer.
   */
  openContact(row: AdminReturnRow): void {
    if (!this.canMutate() || !['REQUESTED', 'CONTACTING', 'NEEDS_SUPPORT'].includes(row.status || '')) return;
    this.contactTarget.set(row);
    this.contactResult.set('reached');
    this.contactNote.set('');
    this.contactError.set(null);
  }

  /**
   * Đóng modal ghi nhận liên hệ.
   */
  closeContact(): void {
    if (this.submitting()) return;
    this.contactTarget.set(null);
    this.contactError.set(null);
  }

  /**
   * Gửi kết quả liên hệ từ modal trực tiếp và chuyển trạng thái sang CONTACTING.
   */
  submitContact(event: Event): void {
    event.preventDefault();
    const row = this.contactTarget();
    if (!row || !this.canMutate() || this.submitting() || row.version == null) return;
    const result = this.contactResult();
    const note = this.contactNote().trim();
    if (!result || note.length < 10) {
      this.contactError.set('Vui lòng chọn kết quả liên hệ và nhập ghi chú trao đổi ít nhất 10 ký tự.');
      return;
    }
    this.submitting.set(true);
    this.contactError.set(null);
    this.api.recordReturnContact(row.return_id, {
      result,
      note,
      expectedVersion: row.version,
    }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => {
        this.contactTarget.set(null);
        this.contactResult.set('');
        this.contactNote.set('');
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === row.return_id) {
          this.openReturnDetail(row.return_id);
        }
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
        this.qaLines.set(lines.map((line) => ({ orderItemId: line.order_item_id!, expectedQuantity: Number(line.quantity), receivedQuantity: String(line.quantity), confirmedItemId: line.order_item_id!, matchesProduct: true })));
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
  /** Records physical product matching for one line and auto-syncs confirmedItemId. */
  setQaLineMatch(orderItemId: string, event: Event): void {
    const matchesProduct = (event.target as HTMLInputElement).checked;
    this.qaLines.update((lines) => lines.map((line) => line.orderItemId === orderItemId ? { ...line, matchesProduct, confirmedItemId: matchesProduct ? line.orderItemId : '' } : line));
  }
  onQaProof(event: Event): void {
    this.qaProof.set('');
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !file.type.startsWith('image/')) { this.qaError.set('Chọn một ảnh minh chứng.'); return; }
    if (file.size > 15 * 1024 * 1024) { this.qaError.set('Ảnh minh chứng tối đa 15 MB.'); return; }
    const returnId = this.receiveTarget()?.return_id;
    compressImageFile(file).then((dataUrl) => {
      if (this.receiveTarget()?.return_id === returnId) {
        this.qaProof.set(dataUrl);
        this.qaError.set(null);
      }
    });
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
    this.actionError.set(null);
    this.api.updateReturnStatus(row.return_id, { status, expectedVersion: row.version }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => {
        this.actionError.set(null);
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === row.return_id) {
          this.openReturnDetail(row.return_id);
        }
      },
      error: (error: unknown) => {
        this.actionError.set(adminErrorMessage(error));
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === row.return_id) {
          this.openReturnDetail(row.return_id);
        }
      }
    });
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
      next: () => {
        this.shipmentTarget.set(null);
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === target.row.return_id) {
          this.openReturnDetail(target.row.return_id);
        }
      },
      error: (error: unknown) => {
        this.shipmentError.set(adminErrorMessage(error));
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === target.row.return_id) {
          this.openReturnDetail(target.row.return_id);
        }
      },
    });
  }

  /** Allows recorded transfer evidence only for captured payments outside Stripe. */
  canRecordManualRefund(row: AdminReturnRow): boolean {
    const isRefund = row.return_type === 'refund' || row.request_type === 'refund';
    const isReceivedPass = ['RECEIVED', 'REFUND_PROCESSING'].includes(row.status || '') && row.condition_check_result === 'qa_pass';
    if (!this.canMutate() || !isRefund || !isReceivedPass) return false;
    if (row.payment) {
      return row.payment.payment_provider !== 'stripe';
    }
    return row.payment_method !== 'stripe' && row.payment_method !== 'STRIPE';
  }

  /** Starts transfer evidence recording after warehouse QA. */
  openManualRefund(row: AdminReturnRow): void {
    if (!this.canRecordManualRefund(row)) {
      this.openReturnDetail(row.return_id);
      return;
    }
    this.manualRefundTarget.set(row); this.manualRefundProof.set(''); this.actionError.set(null);
  }

  /** Reads image evidence without assuming the transaction succeeded. */
  onManualRefundProof(event: Event): void {
    this.manualRefundProof.set('');
    const file = (event.target as HTMLInputElement).files?.[0], returnId = this.manualRefundTarget()?.return_id;
    if (!file || !file.type.startsWith('image/')) { this.actionError.set('Chọn một ảnh giao dịch.'); return; }
    if (file.size > 15 * 1024 * 1024) { this.actionError.set('Ảnh giao dịch tối đa 15 MB.'); return; }
    compressImageFile(file).then((dataUrl) => {
      if (this.manualRefundTarget()?.return_id === returnId) {
        this.manualRefundProof.set(dataUrl);
        this.actionError.set(null);
      }
    });
  }

  /** Records transfer evidence once; the server calculates the net refund amount. */
  submitManualRefund(event: Event): void {
    event.preventDefault();
    const row = this.manualRefundTarget(), form = event.target as HTMLFormElement;
    if (!row || !this.canRecordManualRefund(row) || this.submitting() || row.version == null) return;
    const transferReference = (form.elements.namedItem('reference') as HTMLInputElement | null)?.value.trim() || '';
    const adminNote = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value.trim() || '';
    if (transferReference.length < 6) {
      this.actionError.set('Mã giao dịch chuyển tiền phải có ít nhất 6 ký tự (ví dụ: FT2409012345).');
      return;
    }
    if (adminNote.length < 10) {
      this.actionError.set('Nội dung / Ghi chú kế toán phải có ít nhất 10 ký tự.');
      return;
    }
    if (!this.manualRefundProof() || (!this.manualRefundProof().startsWith('data:image/') && !this.manualRefundProof().startsWith('https://'))) {
      this.actionError.set('Vui lòng tải lên ảnh chụp biên lai chuyển tiền thành công.');
      return;
    }
    this.actionError.set(null);
    this.submitting.set(true);
    this.api.recordManualRefund(row.return_id, {
      expectedVersion: row.version,
      transferReference,
      adminNote,
      imageProof: this.manualRefundProof(),
    }).pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => {
        this.manualRefundTarget.set(null);
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === row.return_id) {
          this.openReturnDetail(row.return_id);
        }
      },
      error: (error: unknown) => {
        this.actionError.set(adminErrorMessage(error));
        this.reload();
        if (this.returnDetailOpen() && this.selectedReturn()?.return_id === row.return_id) {
          this.openReturnDetail(row.return_id);
        }
      },
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

  /** Tên khách hàng gắn với phiếu đổi trả */
  customerName(row: AdminReturnRow | null | undefined): string {
    return row?.customer_name || 'Khách vãng lai';
  }

  /** Số điện thoại khách hàng */
  customerPhone(row: AdminReturnRow | null | undefined): string {
    return row?.customer_phone || '';
  }

  /** Mã đơn hàng ngắn gọn dễ nhìn */
  orderCode(row: AdminReturnRow | null | undefined): string {
    return row?.order_code || (row?.order_id ? row.order_id.slice(0, 8).toUpperCase() : '—');
  }

  /** Mã phiếu chuẩn RET-XXXX */
  returnCode(row: AdminReturnRow | null | undefined): string {
    if (!row) return '—';
    return row.tracking_return_code || ('RET-' + row.return_id.slice(0, 8).toUpperCase());
  }

  setReturnTab(tab: 'all' | 'attention' | 'warehouse' | 'refund' | 'completed'): void {
    this.returnTab.set(tab);
  }

  applyReturnFilters(event: Event): void {
    event.preventDefault();
    this.page.set(1);
    this.reload();
  }

  resetReturnFilters(event: Event): void {
    event.preventDefault();
    this.searchQuery.set('');
    this.statusFilter.set('');
    this.typeFilter.set('');
    this.returnTab.set('all');
    this.page.set(1);
    this.reload();
  }

  onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  onStatusFilter(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
  }

  onTypeFilter(event: Event): void {
    this.typeFilter.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
  }

  /**
   * Phương thức thanh toán của đơn gắn với phiếu đổi trả.
   */
  returnPaymentMethod(row: AdminReturnRow): string {
    const method = row.payment_method || row.payment?.payment_method;
    const provider = row.payment?.payment_provider;
    if (provider === 'stripe' || method === 'STRIPE') return 'Stripe';
    if (method === 'COD') return 'COD';
    if (method === 'ONLINE_PAYMENT') return 'Online';
    if (method === 'VNPAY') return 'VNPay';
    if (method === 'MOMO') return 'MoMo';
    return method || '—';
  }

  /**
   * Nhãn trạng thái thanh toán và hoàn tiền của đơn.
   */
  returnPaymentStatus(row: AdminReturnRow): string {
    const isRefunded = row.status === 'REFUNDED' || row.payment?.payment_status === 'refunded';
    if (isRefunded) {
      return (row.payment?.payment_provider === 'stripe' || row.payment_method === 'stripe')
        ? 'Đã hoàn tiền (Stripe)'
        : 'Đã hoàn tiền (Chuyển khoản)';
    }
    const status = row.payment?.payment_status;
    if (status === 'refund_pending') return 'Đang xử lý hoàn tiền';
    if (status === 'paid') return 'Đã thanh toán (Chưa hoàn)';
    if (status === 'pending') return 'Chờ thanh toán';
    if (status === 'failed') return 'Thanh toán thất bại';
    return status || '—';
  }

  isReturnRefunded(row: AdminReturnRow): boolean {
    return row.status === 'REFUNDED' || row.payment?.payment_status === 'refunded';
  }

  canTriggerStripeRefund(row: AdminReturnRow): boolean {
    const isRefund = row.return_type === 'refund' || row.request_type === 'refund';
    const isReceivedPass = ['RECEIVED', 'REFUND_PROCESSING'].includes(row.status || '') && row.condition_check_result === 'qa_pass' && row.version != null;
    if (!this.canMutate() || !isRefund || !isReceivedPass) return false;
    if (row.payment) {
      return row.payment.payment_provider === 'stripe' && row.payment.payment_status !== 'refunded';
    }
    return row.payment_method === 'stripe';
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
