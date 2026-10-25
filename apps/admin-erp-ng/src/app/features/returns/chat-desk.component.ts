import { Subscription, catchError, of } from 'rxjs';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AdminChatClassification,
  AdminChatMessageRow,
  AdminChatOriginal,
  AdminChatReviewInput,
  AdminChatSessionRow,
  AdminErpApiService,
} from '../../core/admin-erp-api.service';
import { CHAT_CLASSIFICATION_FIELDS, HANDOFF_STATUSES, MAX_CHAT_TEXT } from '../../core/admin-erp-service-desk';
import { adminDateTime } from '../../core/admin-erp-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpEmptyState } from '../../shared/ui/admin-empty-state';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpStatusBadge, AdminBadgeTone } from '../../shared/ui/admin-status-badge';

type ReviewAction = AdminChatReviewInput['action'];

const ACTIONS: ReadonlyArray<{ code: ReviewAction; label: string; hint: string; supervisorOnly?: boolean }> = [
  { code: 'outcome', label: 'Ghi nhận kết quả', hint: 'Tóm tắt hướng xử lý đã thống nhất với khách.' },
  { code: 'resolve', label: 'Kết thúc phiên', hint: 'Cần giải pháp cuối cùng và cảm nhận khách hàng.' },
  { code: 'reopen', label: 'Mở lại phiên', hint: 'Khách quay lại sau khi phiên đã đóng.' },
  { code: 'supervisor', label: 'Báo supervisor', hint: 'Chuyển ca khó cho trưởng nhóm CSKH.' },
  { code: 'summary', label: 'Xác nhận tóm tắt', hint: 'Lưu các sự kiện đã kiểm chứng của phiên.' },
  { code: 'moderate', label: 'Đánh dấu nội dung nhạy cảm', hint: 'Cần chọn mức rủi ro và tin nhắn nguồn.' },
  { code: 'correction', label: 'Sửa phân loại', hint: 'Chỉ supervisor: ghi nhãn đúng cho tin đã lọc.', supervisorOnly: true },
  { code: 'refilter', label: 'Lọc lại nội dung gốc', hint: 'Chỉ supervisor: viết lại bản hiển thị công khai.', supervisorOnly: true },
  { code: 'offer', label: 'Gửi ưu đãi hỗ trợ', hint: 'Chỉ ưu đãi đã được duyệt cho phiên này.' },
  { code: 'report_retry', label: 'Thử lại báo cáo', hint: 'Gửi lại báo cáo ca đã lỗi sang bộ phân tích.' },
];

/**
 * CSKH desk for live conversations. The public transcript is all this screen writes to by
 * default; quarantined originals are opened through an audited supervisor request, and every
 * review decision needs an explicit confirmation because it becomes case history.
 */
@Component({
  selector: 'app-erp-chat-desk',
  imports: [AdminErpEmptyState, AdminErpFilterBar, AdminErpIcon, AdminErpStatusBadge, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-desk.component.html',
  styleUrl: './chat-desk.component.scss',
})
export class ChatDeskComponent {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private messagesRequest = new Subscription();

  readonly canMutate = input(false);
  /** Case a deep link asked to open; the desk loads its transcript as soon as the link lands. */
  readonly focusSession = input('');

  /** Records the case already raised, so the operator never re-types an id to find them. */
  readonly sessionLinks = computed(() => {
    const row = this.selected();
    const links: { label: string; commands: readonly string[]; query: Readonly<Record<string, string>> }[] = [];
    if (row?.support_ticket_id) {
      links.push({ label: 'Phiếu hỗ trợ của hội thoại', commands: ['/returns'], query: { tab: 'tickets', focus: row.support_ticket_id } });
    }
    return links;
  });

  readonly sessions = signal<AdminChatSessionRow[]>([]);
  readonly selected = signal<AdminChatSessionRow | null>(null);
  readonly messages = signal<AdminChatMessageRow[]>([]);
  readonly loadingList = signal(true);
  readonly loadingMessages = signal(false);
  readonly listError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly actionNote = signal<string | null>(null);
  readonly busy = signal(false);
  readonly handoffOnly = signal(false);
  readonly handoffStatus = signal('');
  readonly draft = signal('');
  readonly targetMessage = signal<AdminChatMessageRow | null>(null);
  readonly original = signal<AdminChatOriginal | null>(null);
  readonly originalBusy = signal(false);

  readonly reviewAction = signal<ReviewAction>('outcome');
  readonly reviewRisk = signal<'yellow' | 'orange' | 'red'>('yellow');
  readonly resolution = signal('');
  readonly sentiment = signal<'positive' | 'neutral' | 'negative'>('neutral');
  readonly offerId = signal('');
  readonly reportId = signal('');
  readonly filteredText = signal('');
  readonly confirmed = signal(false);
  readonly classification = signal<AdminChatClassification>({
    intent: 'facts',
    level: 'L0',
    issue: 'general',
    sentiment: 'neutral',
    risk: 'green',
    moderation: 'none',
  });

  readonly actions = ACTIONS;
  readonly handoffOptions = HANDOFF_STATUSES;
  readonly riskOptions = CHAT_CLASSIFICATION_FIELDS.risk;
  readonly moderationOptions = CHAT_CLASSIFICATION_FIELDS.moderation;
  readonly maxText = MAX_CHAT_TEXT;

  readonly isSupervisor = computed(() => this.session.can('approve', 'support_tickets'));
  /** Supervisor decisions stay hidden until the capability actually grants approval. */
  readonly visibleActions = computed(() => ACTIONS.filter((action) => !action.supervisorOnly || this.isSupervisor()));
  readonly activeAction = computed(() => ACTIONS.find((action) => action.code === this.reviewAction()));
  readonly offers = computed(() => this.selected()?.metadata?.eligible_offers || []);
  readonly warnings = computed(() => (this.selected()?.metadata?.warnings || []).filter((row) => !row.resolved));
  readonly intelligence = computed(() => this.selected()?.metadata?.intelligence);
  readonly handoff = computed(() => this.selected()?.metadata?.handoff_summary);
  readonly report = computed(() => this.selected()?.metadata?.report_status);
  readonly outcome = computed(() => this.selected()?.metadata?.outcome);
  /** True when the signed-in staff member already owns the case. */
  readonly assignedToMe = computed(() => {
    const me = this.session.session()?.id;
    return Boolean(me && this.selected()?.assigned_to === me);
  });
  readonly replyReady = computed(() => this.draft().trim().length > 0 && this.draft().length <= MAX_CHAT_TEXT);
  /** Text the review endpoint requires for every action, chosen from the fields that apply. */
  readonly reviewTextValue = computed(() => {
    const action = this.reviewAction();
    if (action === 'resolve' || action === 'offer') {
      const resolution = this.resolution().trim();
      if (resolution) {
        return resolution;
      }
      const offer = this.offers().find((row) => row.offer_id === this.offerId());
      return offer?.title || '';
    }
    return this.draft().trim();
  });

  readonly reviewReady = computed(() => {
    if (!this.confirmed() || this.busy() || this.reviewTextValue().length === 0) {
      return false;
    }
    const action = this.reviewAction();
    if (action === 'resolve') {
      return this.resolution().trim().length > 0 && this.sentiment().length > 0;
    }
    if (action === 'offer') {
      return this.offerId().length > 0;
    }
    if (action === 'report_retry') {
      return this.reportId().length > 0;
    }
    if (action === 'moderate') {
      return Boolean(this.targetMessage()?.message_id) && this.riskRisk();
    }
    if (action === 'correction' || action === 'refilter') {
      return Boolean(this.targetMessage()?.message_id);
    }
    return this.draft().trim().length > 0 || this.resolution().trim().length > 0;
  });

  readonly transcriptTone: Record<string, AdminBadgeTone> = {
    pending: 'warning',
    visible: 'success',
    restricted: 'danger',
  };

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => this.messagesRequest.unsubscribe());
    this.load();
    effect(() => {
      const id = this.focusSession();
      if (id && this.selected()?.session_id !== id) {
        this.open({ session_id: id } as AdminChatSessionRow);
      }
    });
  }

  /**
   * Reloads the case queue.
   */
  load(): void {
    this.loadingList.set(true);
    this.listError.set(null);
    this.api
      .listChatSessions({
        handoffOnly: this.handoffOnly() ? 'true' : '',
        handoffStatus: this.handoffStatus(),
        limit: '50',
      })
      .pipe(catchError((error: unknown) => {
        this.listError.set(adminErrorMessage(error, 'Không tải được hàng đợi hội thoại.'));
        return of({ rows: [] as AdminChatSessionRow[] });
      }))
      .subscribe((payload) => {
        this.sessions.set(adminListRows(payload));
        this.loadingList.set(false);
      });
  }

  /**
   * Switches the queue filter.
   */
  setHandoffFilter(field: 'only' | 'status', event: Event): void {
    if (field === 'only') {
      this.handoffOnly.set((event.target as HTMLInputElement).checked);
    } else {
      this.handoffStatus.set((event.target as HTMLSelectElement).value);
    }
    this.load();
  }

  /**
   * Opens a case and reads its public transcript.
   */
  open(row: AdminChatSessionRow): void {
    this.selected.set(row);
    this.original.set(null);
    this.targetMessage.set(null);
    this.actionError.set(null);
    this.actionNote.set(null);
    this.confirmed.set(false);
    this.loadMessages(row.session_id);
  }

  /**
   * Re-reads the transcript without leaving the case.
   */
  refresh(): void {
    const session = this.selected();
    if (!session) {
      return;
    }
    this.loadMessages(session.session_id);
  }

  /**
   * Claims the case for the signed-in staff member.
   */
  claim(): void {
    const session = this.selected();
    if (!session || !this.canMutate() || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.api.assignChatSession(session.session_id).subscribe({
      next: (payload) => {
        this.busy.set(false);
        this.apply(payload.session, payload.messages);
        this.actionNote.set('Đã nhận ca. Nội dung bạn gửi sẽ được ghi vào nhật ký CSKH.');
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không nhận được ca.'));
      },
    });
  }

  /**
   * Sends an agent reply on the case.
   */
  sendReply(): void {
    const session = this.selected();
    const text = this.draft().trim();
    if (!session || !text || !this.canMutate() || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.api.sendChatReply(session.session_id, text).subscribe({
      next: (payload) => {
        this.busy.set(false);
        this.apply(payload.session, payload.messages);
        this.draft.set('');
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không gửi được phản hồi.'));
      },
    });
  }

  /**
   * Chooses the review decision to record.
   */
  chooseAction(action: ReviewAction): void {
    this.reviewAction.set(action);
    this.confirmed.set(false);
    this.actionError.set(null);
    if (action !== 'moderate' && action !== 'correction' && action !== 'refilter') {
      this.targetMessage.set(null);
    }
  }

  /**
   * Selects the transcript line a moderation or correction applies to.
   */
  pickTarget(message: AdminChatMessageRow): void {
    this.targetMessage.set(message);
    const observed = message.metadata?.classification;
    if (observed) {
      this.classification.set({
        intent: observed.intent,
        level: observed.level,
        issue: observed.issue,
        sentiment: observed.sentiment,
        risk: observed.risk,
        moderation: observed.moderation,
      });
    }
  }

  /**
   * Updates one classification field.
   */
  setClassification(field: keyof AdminChatClassification, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.classification.update((current) => ({ ...current, [field]: value }) as AdminChatClassification);
  }

  /**
   * Writes the review decision. A failed request never counts as a saved correction.
   */
  submitReview(): void {
    const session = this.selected();
    if (!session || !this.canMutate() || !this.reviewReady()) {
      return;
    }
    const action = this.reviewAction();
    const body: AdminChatReviewInput = {
      action,
      text: this.reviewTextValue(),
      confirmed: true,
      ...(this.targetMessage()?.message_id ? { messageId: String(this.targetMessage()?.message_id) } : {}),
      ...(action === 'correction' ? { classification: this.classification() } : {}),
      ...(action === 'refilter' && this.filteredText().trim() ? { filteredText: this.filteredText().trim() } : {}),
      ...(action === 'moderate' ? { risk: this.reviewRisk() } : {}),
      ...(action === 'resolve'
        ? { outcome: { resolution: this.resolution().trim(), finalSentiment: this.sentiment() } }
        : {}),
      ...(action === 'offer' ? { offerId: this.offerId() } : {}),
      ...(action === 'report_retry' ? { reportId: this.reportId() } : {}),
      ...(action === 'summary' ? { summary: this.summaryPayload() } : {}),
    };
    this.busy.set(true);
    this.actionError.set(null);
    this.api.reviewChatSession(session.session_id, body).subscribe({
      next: (payload) => {
        this.busy.set(false);
        this.apply(payload.session, payload.messages);
        this.confirmed.set(false);
        this.filteredText.set('');
        this.actionNote.set(this.reviewNote(action, 'Đã lưu quyết định và ghi nhật ký kiểm soát.'));
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không lưu được quyết định.'));
      },
    });
  }

  /**
   * Opens a quarantined original through the audited supervisor endpoint.
   */
  readOriginal(): void {
    const session = this.selected();
    const messageId = this.targetMessage()?.message_id;
    if (!session || !messageId || !this.isSupervisor() || this.originalBusy()) {
      return;
    }
    this.originalBusy.set(true);
    this.actionError.set(null);
    this.api.getChatOriginal(session.session_id, messageId).subscribe({
      next: (original) => {
        this.originalBusy.set(false);
        this.original.set(original);
        this.actionNote.set('Quyền xem nội dung gốc đã được ghi vào audit.');
      },
      error: (error: unknown) => {
        this.originalBusy.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không mở được nội dung gốc.'));
      },
    });
  }

  /**
   * Public label of a transcript message; pending and restricted turns keep their own badge.
   */
  label(message: AdminChatMessageRow): string {
    const sender = String(message.sender || '').toLowerCase();
    if (sender.includes('staff') || sender.includes('agent')) {
      return 'Nhân viên';
    }
    if (sender.includes('ai') || sender.includes('bot')) {
      return 'Trợ lý ảo';
    }
    return 'Khách';
  }

  /**
   * Typing the agent reply.
   */
  setDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Submits the reply form.
   */
  onSubmitReply(event: Event): void {
    event.preventDefault();
    this.sendReply();
  }

  /**
   * Sets the free-text field behind a review decision.
   */
  setReviewField(field: 'resolution' | 'offerId' | 'reportId' | 'filteredText', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'resolution') {
      this.resolution.set(value);
    } else if (field === 'offerId') {
      this.offerId.set(value);
    } else if (field === 'reportId') {
      this.reportId.set(value);
    } else {
      this.filteredText.set(value);
    }
  }

  /**
   * Chooses the final sentiment of a resolved case.
   */
  setSentiment(event: Event): void {
    this.sentiment.set((event.target as HTMLSelectElement).value as 'positive' | 'neutral' | 'negative');
  }

  /**
   * Chooses the moderation risk of a message.
   */
  setReviewRisk(event: Event): void {
    this.reviewRisk.set((event.target as HTMLSelectElement).value as 'yellow' | 'orange' | 'red');
  }

  /**
   * Confirms the review decision; nothing is written until this box is ticked.
   */
  setConfirmed(event: Event): void {
    this.confirmed.set((event.target as HTMLInputElement).checked);
  }

  /**
   * Actions that must point at one transcript message.
   */
  needsTarget(): boolean {
    return ['correction', 'refilter', 'moderate'].includes(this.reviewAction());
  }

  /**
   * Selectable classification fields, in the order the API validates them.
   */
  classificationFields(): Array<{ key: keyof AdminChatClassification; label: string; values: readonly string[] }> {
    return [
      { key: 'intent', label: 'Ý định', values: CHAT_CLASSIFICATION_FIELDS.intent },
      { key: 'level', label: 'Cấp xử lý', values: CHAT_CLASSIFICATION_FIELDS.level },
      { key: 'issue', label: 'Vấn đề', values: CHAT_CLASSIFICATION_FIELDS.issue },
      { key: 'sentiment', label: 'Cảm nhận', values: CHAT_CLASSIFICATION_FIELDS.sentiment },
      { key: 'risk', label: 'Rủi ro', values: CHAT_CLASSIFICATION_FIELDS.risk },
      { key: 'moderation', label: 'Kiểm duyệt', values: CHAT_CLASSIFICATION_FIELDS.moderation },
    ];
  }

  /**
   * Timestamp label.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Risk badge tone of a case.
   */
  riskTone(level: string | null | undefined): AdminBadgeTone {
    const tones: Record<string, AdminBadgeTone> = { green: 'success', yellow: 'warning', orange: 'warning', red: 'danger' };
    return tones[String(level || '')] || 'neutral';
  }

  /**
   * Handoff state label.
   */
  handoffLabel(status: string | null | undefined): string {
    return HANDOFF_STATUSES.find((option) => option.code === status)?.label || String(status || 'Chưa phân công');
  }

  private loadMessages(sessionId: string): void {
    this.messagesRequest.unsubscribe();
    this.loadingMessages.set(true);
    this.messagesRequest = this.api.getChatMessages(sessionId).subscribe({
      next: (payload) => {
        this.messages.set(payload.messages || []);
        if (payload.session) {
          this.selected.set(payload.session);
        }
        this.loadingMessages.set(false);
      },
      error: (error: unknown) => {
        this.loadingMessages.set(false);
        this.actionError.set(adminErrorMessage(error, 'Không tải được hội thoại.'));
      },
    });
  }

  private apply(session: AdminChatSessionRow | undefined, messages: AdminChatMessageRow[] | undefined): void {
    if (session) {
      this.selected.set(session);
    }
    if (messages) {
      this.messages.set(messages);
    }
  }

  private reviewNote(action: ReviewAction, base: string): string {
    return action === 'resolve' ? `${base} Phiên đã kết thúc.` : base;
  }

  private riskRisk(): boolean {
    return ['yellow', 'orange', 'red'].includes(this.reviewRisk());
  }

  private summaryPayload(): { problem: string; wanted: string; failed_approaches: string[] } {
    const handoff = this.handoff();
    return {
      problem: handoff?.problem || this.resolution().trim() || 'Chưa ghi nhận vấn đề',
      wanted: handoff?.wanted || 'Khách cần được hỗ trợ tiếp',
      failed_approaches: handoff?.failed_approaches || [],
    };
  }
}
