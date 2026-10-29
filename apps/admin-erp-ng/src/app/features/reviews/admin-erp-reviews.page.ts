import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, type ParamMap } from '@angular/router';
import { catchError, finalize, forkJoin, of } from 'rxjs';
import { choiceParam, textParam, watchQueryParams } from '../../core/admin-erp-deep-link';
import { AdminAuditRow, AdminErpApiService, AdminReviewRow } from '../../core/admin-erp-api.service';
import { adminDateTime, adminStars } from '../../core/admin-erp-format';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { REVIEW_STATUS_LABELS, statusLabelFrom } from '../../core/admin-erp-status-labels';
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

type ReviewTab = 'all' | 'urgent' | 'processed' | 'logs';

const REVIEW_TABS: readonly string[] = ['all', 'urgent', 'processed', 'logs'];
type ReviewAction = 'approve' | 'hide' | 'unhide' | 'reply' | 'escalate' | null;

const EMPTY_REVIEWS = { rows: [] as AdminReviewRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

const RESTRICTED_PATTERNS: readonly string[] = [
  'mấy má',
  'mấy mẹ',
  'nhận xu',
  'kiếm xu',
  'lừa đảo',
  'hàng đểu',
  'fake',
  'treo đầu dê',
  'bố láo',
  'mất dạy',
  'chó chết',
];

/**
 * Review moderation queue with real API actions, AI reply suggestions and audit.
 */
@Component({
  selector: 'app-admin-erp-reviews-page',
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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-reviews.page.html',
  styleUrl: './admin-erp-reviews.page.scss',
})
export class AdminErpReviewsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly tab = signal<ReviewTab>('all');
  readonly query = signal('');
  readonly ratingFilter = signal('');
  readonly statusFilter = signal('');
  readonly rows = signal<AdminReviewRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly page = signal(1);
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly logsCount = signal(0);
  readonly urgentCount = signal(0);
  readonly processedCount = signal(0);
  readonly hiddenCount = signal(0);
  readonly selected = signal<AdminReviewRow | null>(null);
  readonly selectedLog = signal<AdminAuditRow | null>(null);
  readonly detailError = signal<string | null>(null);
  readonly actionSaving = signal(false);
  readonly actionType = signal<ReviewAction>(null);
  readonly actionError = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly discardOpen = signal(false);
  readonly replyDraft = signal('');
  readonly aiSuggestions = signal<string[]>([]);
  readonly aiLoading = signal(false);
  readonly aiError = signal<string | null>(null);
  readonly aiSource = signal<string | null>(null);
  readonly detectedRestrictedWords = signal<string[]>([]);
  readonly sentiment = signal<{ label: string; tone: string; score: number } | null>(null);
  readonly lightboxImage = signal<string | null>(null);
  readonly selectedRestrictedWords = computed(() => {
    const review = this.selected();
    return review ? this.detectRestrictedWords(this.commentOf(review)) : [];
  });
  readonly canMutate = computed(() => this.session.can('update', 'reviews'));

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.kpiNumber(this.total()) },
    { key: 'urgent', label: 'Cần xử lý gấp', count: this.kpiNumber(this.urgentCount()) },
    { key: 'processed', label: 'Đã xử lý', count: this.kpiNumber(this.processedCount()) },
    { key: 'logs', label: 'Nhật ký' },
  ]);
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'đánh giá'));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));

  readonly reviewColumns: readonly AdminTableColumn[] = [
    {
      key: 'review',
      label: 'Đánh giá',
      value: (row) => this.commentOf(row as AdminReviewRow),
    },
    {
      key: 'product',
      label: 'Sản phẩm',
      value: (row) => this.productName(row as AdminReviewRow),
    },
    {
      key: 'customer',
      label: 'Khách hàng',
      value: (row) => String((row as AdminReviewRow).user_id || (row as AdminReviewRow).order_id || '—'),
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => this.statusLabel((row as AdminReviewRow).status),
      badge: (row) => ({ label: this.statusLabel((row as AdminReviewRow).status), tone: this.statusTone((row as AdminReviewRow).status) }),
    },
    { key: 'date', label: 'Ngày tạo', value: (row) => this.date((row as AdminReviewRow).submitted_at) },
    {
      key: 'urgent',
      label: 'Ưu tiên',
      value: (row) => ((row as AdminReviewRow).is_flagged_urgent ? 'Gấp' : '—'),
      badge: (row) =>
        (row as AdminReviewRow).is_flagged_urgent ? { label: 'Gấp', tone: 'danger' as const } : null,
    },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => this.actionLabel(row as AdminAuditRow) },
    { key: 'target', label: 'Đối tượng', value: (row) => this.target(row as AdminAuditRow) },
  ];

  constructor() {
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    this.loadCounts();
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Applies an inbound deep link: the moderation queue and the search another workspace names.
   */
  private applyDeepLink(params: ParamMap): void {
    this.tab.set(choiceParam(params, 'tab', REVIEW_TABS, this.tab()) as ReviewTab);
    this.query.set(textParam(params, 'q'));
    this.page.set(1);
    this.logsPage.set(1);
    this.reload();
  }

  /**
   * Reloads the active review tab from the API.
   */
  reload(): void {
    if (this.tab() === 'logs') {
      this.loadLogs();
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const tab = this.tab();
    const params: Record<string, string> = {
      q: this.query(),
      rating: this.ratingFilter(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    if (tab === 'processed') {
      if (this.statusFilter()) params['status'] = this.statusFilter();
      else params['processed'] = 'true';
    } else {
      params['status'] = this.statusFilter();
    }
    if (tab === 'urgent') {
      params['urgent'] = 'true';
    }
    this.api.listReviews(params).subscribe({
      next: (payload) => {
        this.rows.set(adminListRows(payload));
        this.total.set(adminListCount(payload));
        this.loading.set(false);
        this.hasLoadedOnce.set(true);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được đánh giá.'));
        this.rows.set([]);
        this.total.set(0);
        this.loading.set(false);
      },
    });
  }

  /**
   * Loads the three KPI counts with count-only queries.
   */
  loadCounts(): void {
    const countOnly = (params: Record<string, string>) =>
      this.api.listReviews({ ...params, limit: '1' }).pipe(catchError(() => of(EMPTY_REVIEWS)));
    forkJoin({
      approved: countOnly({ status: 'approved' }),
      rejected: countOnly({ status: 'rejected' }),
      urgent: countOnly({ urgent: 'true' }),
    }).subscribe((payload) => {
      this.hiddenCount.set(adminListCount(payload.rejected));
      this.urgentCount.set(adminListCount(payload.urgent));
      this.processedCount.set(adminListCount(payload.approved) + adminListCount(payload.rejected));
    });
  }

  /**
   * Loads the review audit tab.
   */
  loadLogs(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .listReviewAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) })
      .subscribe({
        next: (payload) => {
          this.logs.set(adminListRows(payload));
          this.logsCount.set(adminListCount(payload));
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký đánh giá.'));
          this.loading.set(false);
        },
      });
  }

  /**
   * Switches review tabs.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!REVIEW_TABS.includes(tab)) {
      return;
    }
    this.tab.set(tab as ReviewTab);
    this.page.set(1);
    this.logsPage.set(1);
    this.closeOverlays();
    this.reload();
  }

  /**
   * Applies server-side review filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears review filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.ratingFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves review paging.
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
   * Opens the review detail drawer and loads the full payload.
   */
  openDetail(row: unknown): void {
    const review = row as AdminReviewRow;
    this.selected.set(review);
    this.detailError.set(null);
    this.sentiment.set(this.analyzeSentiment(review));
    this.actionType.set(null);
    this.api.getReview(review.review_id).subscribe({
      next: (full) => {
        if (this.selected()?.review_id === review.review_id) {
          this.selected.set(full);
        }
      },
      error: (error: unknown) => {
        if (this.selected()?.review_id === review.review_id) {
          this.detailError.set(adminErrorMessage(error, 'Không tải được chi tiết đánh giá.'));
        }
      },
    });
  }

  /**
   * Retries the detail request after a transient failure.
   */
  retryDetail(): void {
    const review = this.selected();
    if (review) this.openDetail(review);
  }

  /**
   * Opens the review audit drawer.
   */
  openLog(row: unknown): void {
    this.selectedLog.set(row as AdminAuditRow);
  }

  /**
   * Opens an action modal for the selected review.
   */
  openAction(type: Exclude<ReviewAction, null>): void {
    const row = this.selected();
    if (!this.canMutate() || !row) {
      return;
    }
    this.actionType.set(type);
    this.actionError.set(null);
    this.dirty.set(false);
    this.replyDraft.set(row.admin_reply || '');
    this.detectedRestrictedWords.set(this.detectRestrictedWords(this.commentOf(row)));
    this.sentiment.set(this.analyzeSentiment(row));
    if (type === 'reply') {
      this.requestAiReply(row.review_id);
    }
  }

  /**
   * Closes drawers and action modals. A dirty action form asks before discarding typed text.
   */
  closeOverlays(): void {
    if (this.dirty()) {
      this.discardOpen.set(true);
      return;
    }
    this.forceClose();
  }

  /**
   * Marks the open action form as edited.
   */
  markDirty(): void {
    this.dirty.set(true);
  }

  /**
   * Confirms discarding typed text and closes every overlay.
   */
  confirmDiscard(): void {
    this.discardOpen.set(false);
    this.dirty.set(false);
    this.forceClose();
  }

  /**
   * Keeps the action modal open after the discard prompt is cancelled.
   */
  cancelDiscard(): void {
    this.discardOpen.set(false);
  }

  private forceClose(): void {
    this.selected.set(null);
    this.selectedLog.set(null);
    this.actionType.set(null);
    this.actionError.set(null);
    this.lightboxImage.set(null);
    this.replyDraft.set('');
    this.aiSuggestions.set([]);
    this.aiError.set(null);
    this.detectedRestrictedWords.set([]);
    this.sentiment.set(null);
    this.dirty.set(false);
    this.discardOpen.set(false);
    this.detailError.set(null);
  }

  /**
   * Opens the image lightbox.
   */
  openLightbox(image: string): void {
    this.lightboxImage.set(image);
  }

  /**
   * Closes the image lightbox.
   */
  closeLightbox(): void {
    this.lightboxImage.set(null);
  }

  /**
   * Submits the selected review action.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    if (!this.canMutate() || this.actionSaving()) {
      return;
    }
    const row = this.selected();
    const type = this.actionType();
    if (!row || !type || !row.version) {
      this.actionError.set('Thiếu phiên bản đánh giá để thao tác.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const note = this.field(form, 'actionNote').value.trim();
    const formValue = this.field(form, 'value').value;
    const value = type === 'reply' ? this.replyDraft() : formValue;
    if ((type === 'reply' || type === 'hide' || type === 'escalate') && !value.trim()) {
      this.actionError.set(type === 'reply' ? 'Vui lòng nhập nội dung phản hồi.' : 'Vui lòng nhập lý do xử lý.');
      return;
    }
    // Approve may add a public reply; every other action never writes into admin_reply.
    const payload: Record<string, unknown> = { expectedVersion: row.version };
    if (type === 'approve' && note) {
      payload['actionNote'] = note;
    }
    const request$ =
      type === 'approve' || type === 'unhide'
        ? this.api.approveReview(row.review_id, payload)
        : type === 'hide'
          ? this.api.hideReview(row.review_id, { ...payload, reason: value })
          : type === 'reply'
            ? this.api.replyReview(row.review_id, { ...payload, reply: value.trim() })
            : this.api.escalateReview(row.review_id, { ...payload, reason: value });
    this.actionSaving.set(true);
    request$.pipe(finalize(() => this.actionSaving.set(false))).subscribe({
      next: () => {
        this.dirty.set(false);
        this.closeOverlays();
        this.reload();
        this.loadCounts();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Requests AI reply suggestions without inventing a fallback reply.
   */
  requestAiReply(reviewId: string): void {
    this.aiLoading.set(true);
    this.aiError.set(null);
    this.aiSuggestions.set([]);
    this.aiSource.set(null);
    const stillCurrent = () => this.selected()?.review_id === reviewId && this.actionType() === 'reply';
    this.api.suggestReviewReply(reviewId).subscribe({
      next: (result) => {
        if (!stillCurrent()) return;
        this.aiLoading.set(false);
        this.aiSuggestions.set(result.replies || []);
        this.aiSource.set(result.source || null);
        if (!(result.replies || []).length) {
          this.aiError.set('AI không trả về câu phản hồi. Viết tay trong ô bên dưới.');
        }
      },
      error: (error: unknown) => {
        if (!stillCurrent()) return;
        this.aiLoading.set(false);
        this.aiSuggestions.set([]);
        this.aiError.set(adminErrorMessage(error, 'Không lấy được gợi ý AI. Viết phản hồi tay.'));
      },
    });
  }

  /**
   * Applies an AI suggestion to the reply draft.
   */
  applyAiSuggestion(text: string): void {
    this.replyDraft.set(text);
    this.dirty.set(true);
  }

  /**
   * Updates the reply draft.
   */
  onReplyInput(event: Event): void {
    this.replyDraft.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Updates the review query filter.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the rating filter.
   */
  onRatingFilter(event: Event): void {
    this.ratingFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the status filter.
   */
  onStatusFilter(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Review comment/content.
   */
  commentOf(row: AdminReviewRow): string {
    return row.comment || row.content || '—';
  }

  /**
   * Product title.
   */
  productName(row: AdminReviewRow): string {
    return row.product?.name || row.product_name || '—';
  }

  /**
   * Product SKU.
   */
  productSku(row: AdminReviewRow): string {
    return row.product?.sku || row.product_id || '';
  }

  /**
   * Stars label.
   */
  stars(row: AdminReviewRow): string {
    return adminStars(row.rating);
  }

  /**
   * Status label.
   */
  statusLabel(status: string | undefined): string {
    return statusLabelFrom(REVIEW_STATUS_LABELS, status);
  }

  /**
   * Status tone.
   */
  statusTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
    if (status === 'approved') return 'success';
    if (status === 'rejected') return 'danger';
    if (status === 'pending') return 'warning';
    return 'neutral';
  }

  /**
   * Format timestamp.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Action modal title.
   */
  actionTitle(): string {
    const type = this.actionType();
    if (type === 'approve') return 'Phê duyệt đánh giá';
    if (type === 'unhide') return 'Mở ẩn đánh giá';
    if (type === 'hide') return 'Ẩn đánh giá';
    if (type === 'reply') return 'Phản hồi đánh giá';
    return 'Tạo ticket CSKH';
  }

  /**
   * Detects restricted words in the review content.
   */
  detectRestrictedWords(text: string): string[] {
    const lower = text.toLowerCase();
    return RESTRICTED_PATTERNS.filter((word) => lower.includes(word));
  }

  /**
   * Lightweight sentiment signal for the operator; not a model claim.
   */
  analyzeSentiment(row: AdminReviewRow): { label: string; tone: string; score: number } {
    const rating = row.rating || 0;
    const comment = this.commentOf(row).toLowerCase();
    const negative = ['xấu', 'tệ', 'rách', 'lỗi', 'chật', 'rộng', 'thất vọng', 'kém', 'lừa', 'không giống', 'hỏng'];
    const hasNegative = negative.some((word) => comment.includes(word));
    if (rating >= 4 && !hasNegative) return { label: 'Tích cực', tone: 'positive', score: rating };
    if (rating <= 2 || hasNegative) return { label: 'Tiêu cực', tone: 'negative', score: rating || 1 };
    return { label: 'Trung tính', tone: 'neutral', score: rating || 3 };
  }

  /**
   * KPI display before the first successful load.
   */
  kpi(value: number): string {
    return this.hasLoadedOnce() ? value.toLocaleString('vi-VN') : '—';
  }

  /**
   * Tab count that hides zero until the first load.
   */
  private kpiNumber(value: number): number | undefined {
    return this.hasLoadedOnce() ? value : undefined;
  }

  /**
   * Actor label for review audit.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  /**
   * Action label for review audit.
   */
  actionLabel(row: AdminAuditRow): string {
    return row.action_label || row.action || '—';
  }

  /**
   * Target label for review audit.
   */
  target(row: AdminAuditRow): string {
    return row.target_label || row.target_id || '—';
  }

  private field(form: HTMLFormElement, name: string): HTMLInputElement {
    return (form.elements.namedItem(name) as HTMLInputElement | null) ?? document.createElement('input');
  }
}
