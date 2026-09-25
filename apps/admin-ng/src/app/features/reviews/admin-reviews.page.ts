import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminAuditRow, AdminReviewRow } from '../../core/admin-api.service';
import { adminDateTime, adminStars } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { REVIEW_STATUS_LABELS, statusLabelFrom } from '../../core/admin-status-labels';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';
import { AdminTableSkeleton } from '../../shared/admin-table-skeleton';

type ReviewTab = 'all' | 'pending' | 'urgent' | 'processed' | 'logs';
type ReviewAction = 'approve' | 'hide' | 'unhide' | 'reply' | 'escalate' | null;

/** Không có payload khi tab hiện tại không cần tới danh sách đó. */
const EMPTY_LIST = { rows: [] as AdminReviewRow[], count: 0 };

@Component({
  selector: 'app-admin-reviews-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination, AdminTableSkeleton],
  templateUrl: './admin-reviews.page.html',
})
export class AdminReviewsPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly tab = signal<ReviewTab>('all');
  readonly query = signal('');
  readonly ratingFilter = signal('');
  readonly statusFilter = signal('');
  readonly rows = signal<AdminReviewRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
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
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly logsCount = signal(0);
  readonly selected = signal<AdminReviewRow | null>(null);
  readonly actionType = signal<ReviewAction>(null);
  readonly actionError = signal<string | null>(null);
  readonly menuId = signal<string | null>(null);
  readonly detailOpen = signal(false);
  readonly lightboxImage = signal<string | null>(null);
  readonly canMutate = computed(() => this.session.canMutate('reviews'));

  // Signals trợ lý AI CSKH, nhận diện từ cấm và gợi ý phản hồi
  readonly replyDraft = signal<string>('');
  readonly aiSuggestions = signal<string[]>([]);
  readonly detectedRestrictedWords = signal<string[]>([]);
  readonly sentiment = signal<{ label: string; tone: string; score: number } | null>(null);

  // Các con số này đếm trên toàn bộ dữ liệu, không phải trên 10 dòng của trang hiện
  // tại. Trước đây chúng là `computed` trên `rows()`, nên ở tab "Chờ duyệt" con số
  // "Chờ duyệt" luôn bằng đúng cỡ trang còn "Đã xử lý" luôn bằng 0.
  readonly pendingCount = signal(0);
  readonly urgentCount = signal(0);
  readonly hiddenCount = signal(0);
  readonly processedCount = signal(0);
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly paged = computed(() => this.rows());
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'đánh giá'));
  readonly pagedLogs = computed(() => this.logs());
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));

  constructor() {
    this.reload();
    this.loadCounts();
  }

  /**
   * Reloads reviews from `/api/v1/admin/reviews`.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);

    // Tab "Cần xử lý gấp" trước đây không đổi tham số truy vấn nào cả, nên nó hiện ra
    // y hệt tab "Tất cả". Nay lọc thật ở phía máy chủ.
    const tab = this.tab();
    let status = this.statusFilter();
    if (tab === 'pending') {
      status = 'pending';
    } else if (tab === 'processed') {
      status = 'approved';
    }

    const listParams: Record<string, string> = {
      q: this.query(),
      rating: this.ratingFilter(),
      status,
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    if (tab === 'urgent') {
      listParams['urgent'] = 'true';
    }

    // Mỗi KPI là một truy vấn đếm `limit=1`: máy chủ trả về tổng số qua tiêu đề count
    // mà không phải tải dữ liệu về.
    this.api
      .listReviews(listParams)
      .pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error));
          return of(EMPTY_LIST);
        }),
      )
      .subscribe((payload) => {
        this.rows.set(adminListRows(payload));
        this.total.set(adminListCount(payload));
        this.loading.set(false);
        this.hasLoadedOnce.set(true);
      });
  }

  /**
   * Tải các chỉ số đầu trang.
   *
   * Tách khỏi `reload()` vì bấm sang trang không làm mấy con số này đổi: gọi lại chúng
   * ở mỗi lần phân trang là bốn truy vấn thừa cho một thông tin không thay đổi. Chúng
   * chỉ cần chạy lại khi dữ liệu thật sự đổi — lần đầu vào trang, đổi bộ lọc, và sau
   * mỗi thao tác duyệt/ẩn.
   */
  loadCounts(): void {
    const countOnly = (params: Record<string, string>) =>
      this.api.listReviews({ ...params, limit: '1' }).pipe(catchError(() => of(EMPTY_LIST)));

    forkJoin({
      pending: countOnly({ status: 'pending' }),
      approved: countOnly({ status: 'approved' }),
      rejected: countOnly({ status: 'rejected' }),
      urgent: countOnly({ urgent: 'true' }),
    }).subscribe((payload) => {
      this.pendingCount.set(adminListCount(payload.pending));
      this.hiddenCount.set(adminListCount(payload.rejected));
      this.urgentCount.set(adminListCount(payload.urgent));
      // "Đã xử lý" là mọi đánh giá đã rời khỏi hàng chờ, gồm cả đã duyệt lẫn đã ẩn.
      this.processedCount.set(adminListCount(payload.approved) + adminListCount(payload.rejected));
    });
  }

  /**
   * Switches the original review tablist.
   */
  setTab(tab: ReviewTab): void {
    this.tab.set(tab);
    this.page.set(1);
    this.menuId.set(null);
    if (tab === 'logs') {
      this.api.listReviewAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) }).subscribe({
        next: (payload) => {
          this.logs.set(adminListRows(payload));
          this.logsCount.set(adminListCount(payload));
        },
        error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
      });
      return;
    }
    this.reload();
  }

  /**
   * Applies the original review filter bar.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.ratingFilter.set((form.elements.namedItem('rating') as HTMLSelectElement | null)?.value || '');
    this.statusFilter.set((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '');
    this.page.set(1);
    this.reload();
    this.loadCounts();
  }

  /**
   * Clears the original review filters.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.ratingFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
    this.reload();
    this.loadCounts();
  }

  /**
   * Moves review pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
    this.reload();
  }

  /**
   * Moves review-log pagination.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logPageCount(), Math.max(1, page)));
    this.api.listReviewAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
      },
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Opens or closes the original row action menu.
   */
  toggleMenu(reviewId: string): void {
    this.menuId.update((current) => (current === reviewId ? null : reviewId));
  }

  /**
   * Opens the original review detail drawer.
   */
  openDetail(reviewId: string): void {
    this.menuId.set(null);
    this.api.getReview(reviewId).subscribe({
      next: (row) => {
        this.selected.set(row);
        this.detailOpen.set(true);
        this.actionType.set(null);
      },
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Danh sách từ khóa nhạy cảm / từ cấm / spam cần cảnh báo cho CSKH.
   */
  readonly restrictedPatterns: readonly string[] = [
    'mấy má', 'may ma', 'mấy mẹ', 'nhận xu', 'nhan xu', 'kiếm xu', 'kiem xu',
    'đm', 'dm', 'đmm', 'vcl', 'vl', 'cl', 'vcc', 'dcm', 'đcm', 'lừa đảo', 'lua dao',
    'fake', 'fake lòi', 'như cc', 'nhu cc', 'hàng đểu', 'treo đầu dê', 'bố láo', 'mất dạy', 'chó chết'
  ];

  detectRestrictedWords(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    return this.restrictedPatterns.filter((word) => lower.includes(word));
  }

  analyzeSentiment(row: AdminReviewRow): { label: string; tone: string; score: number } {
    const rating = row.rating || 0;
    const comment = (this.commentOf(row) || '').toLowerCase();
    const negativeKeywords = ['xấu', 'tệ', 'rách', 'lỗi', 'chật', 'rộng', 'thất vọng', 'kém', 'lừa', 'không giống', 'hỏng'];
    const hasNegativeKeyword = negativeKeywords.some((w) => comment.includes(w));

    if (rating >= 4 && !hasNegativeKeyword) {
      return { label: 'Tích cực', tone: 'positive', score: rating };
    }
    if (rating <= 2 || hasNegativeKeyword) {
      return { label: 'Tiêu cực', tone: 'negative', score: rating || 1 };
    }
    return { label: 'Trung tính', tone: 'neutral', score: rating || 3 };
  }

  generateAiSuggestions(row: AdminReviewRow, sentiment: { label: string; tone: string }): string[] {
    const prodName = this.productName(row) || 'sản phẩm';
    if (sentiment.tone === 'positive') {
      return [
        `Chào bạn, Velura chân thành cảm ơn bạn đã tin tưởng và đánh giá 5 sao cho ${prodName}! Sự hài lòng của bạn là niềm vui và động lực lớn nhất của chúng mình. Chúc bạn luôn rạng rỡ và tự tin mỗi ngày cùng Velura nhé!`,
        `Dạ Velura xin gửi lời cảm ơn sâu sắc đến quý khách ạ! Velura xin gửi tặng bạn voucher ưu đãi 10% cho đơn hàng kế tiếp. Hy vọng bạn sẽ luôn đồng hành và ủng hộ Velura trong thời gian tới!`,
        `Cảm ơn bạn đã lựa chọn ${prodName} từ Velura! Để trang phục luôn bền đẹp như mới, bạn lưu ý giặt ở chế độ nhẹ và phơi nơi thoáng mát nhé. Chúc bạn một ngày thật nhiều niềm vui!`,
      ];
    }
    if (sentiment.tone === 'negative') {
      return [
        `Chào bạn, Velura thành thật xin lỗi vì trải nghiệm chưa trọn vẹn với ${prodName}. Bộ phận CSKH Velura xin phép liên hệ hỗ trợ đổi trả mới hoặc hoàn tiền ngay trong hôm nay theo chính sách 30 ngày. Rất mong bạn cho Velura cơ hội khắc phục ạ!`,
        `Dạ Velura chân thành xin lỗi bạn về sự bất tiện này. Chúng mình sẽ liên hệ hỗ trợ bạn đổi size/màu hoặc kiểm tra đổi sản phẩm mới hoàn toàn miễn phí ship 2 chiều ngay hôm nay ạ. Mong bạn thông cảm cho sơ suất của shop nhé!`,
        `Velura đã ghi nhận phản hồi đóng góp quý báu từ bạn và chuyển ngay cho bộ phận sản xuất kiểm tra chất lượng. CSKH Velura sẽ gọi điện hỗ trợ giải quyết thỏa đáng nhất cho bạn ngay trong ít phút tới ạ. Cảm ơn bạn!`,
      ];
    }
    return [
      `Chào bạn, cảm ơn bạn đã gửi đánh giá cho sản phẩm ${prodName}. Không biết sản phẩm còn điểm nào chưa hoàn toàn làm bạn ưng ý không ạ? Bạn có thể nhắn tin cho CSKH Velura để được hỗ trợ và tư vấn chu đáo hơn nhé!`,
      `Dạ Velura cảm ơn quý khách đã tin tưởng mua sắm. Mọi góp ý của bạn là động lực để Velura ngày càng hoàn thiện chất lượng và dịch vụ hơn nữa. Chúc bạn một ngày tốt lành!`,
      `Chào bạn, nếu bạn cần hỗ trợ thêm về hướng dẫn bảo quản trang phục, đổi size hoặc tư vấn phối đồ, đừng ngần ngại liên hệ CSKH Velura bất cứ lúc nào nhé ạ!`,
    ];
  }

  applyAiSuggestion(text: string): void {
    this.replyDraft.set(text);
  }

  onReplyInput(event: Event): void {
    this.replyDraft.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Opens approve / hide / reply / escalate modal with AI context.
   */
  openAction(type: Exclude<ReviewAction, null>, reviewId: string): void {
    const row = this.rows().find((item) => item.review_id === reviewId) || null;
    this.selected.set(row);
    this.actionType.set(type);
    this.detailOpen.set(false);
    this.actionError.set(null);
    this.menuId.set(null);

    if (row) {
      this.replyDraft.set(row.admin_reply || '');
      const comment = this.commentOf(row);
      this.detectedRestrictedWords.set(this.detectRestrictedWords(comment));
      const s = this.analyzeSentiment(row);
      this.sentiment.set(s);
      this.aiSuggestions.set(this.generateAiSuggestions(row, s));
    }

    // Tải chi tiết bổ sung (ảnh, thông tin người dùng) nếu có
    this.api.getReview(reviewId).subscribe({
      next: (fullRow) => {
        if (this.selected()?.review_id === reviewId) {
          this.selected.set(fullRow);
          if (type === 'reply' && !this.replyDraft()) {
            this.replyDraft.set(fullRow.admin_reply || '');
          }
          const comment = this.commentOf(fullRow);
          this.detectedRestrictedWords.set(this.detectRestrictedWords(comment));
          const s = this.analyzeSentiment(fullRow);
          this.sentiment.set(s);
          this.aiSuggestions.set(this.generateAiSuggestions(fullRow, s));
        }
      },
      error: () => {},
    });
  }

  /**
   * Closes drawers and action modals.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionType.set(null);
    this.detailOpen.set(false);
    this.actionError.set(null);
    this.lightboxImage.set(null);
    this.replyDraft.set('');
    this.aiSuggestions.set([]);
    this.detectedRestrictedWords.set([]);
    this.sentiment.set(null);
  }

  /**
   * Opens a review image full-size in a lightbox overlay.
   */
  openLightbox(image: string): void {
    this.lightboxImage.set(image);
  }

  /**
   * Closes the image lightbox without dismissing the detail drawer.
   */
  closeLightbox(): void {
    this.lightboxImage.set(null);
  }

  /**
   * Submits a review action through the original admin APIs.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const row = this.selected();
    const type = this.actionType();
    if (!row || !type || !row.version) {
      this.actionError.set('Thiếu phiên bản đánh giá để thao tác.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const note = (form.elements.namedItem('actionNote') as HTMLTextAreaElement | null)?.value || '';
    const formValue = (form.elements.namedItem('value') as HTMLTextAreaElement | null)?.value || '';
    const value = type === 'reply' ? this.replyDraft() : formValue;

    if (type === 'reply' && (!value || !value.trim())) {
      this.actionError.set('Vui lòng nhập nội dung phản hồi đánh giá.');
      return;
    }

    const payload = { expectedVersion: row.version };
    const request$ =
      type === 'approve' || type === 'unhide'
        ? this.api.approveReview(row.review_id, { ...payload, actionNote: note })
        : type === 'hide'
          ? this.api.hideReview(row.review_id, { ...payload, reason: value })
          : type === 'reply'
            ? this.api.replyReview(row.review_id, { ...payload, reply: value.trim() })
            : this.api.escalateReview(row.review_id, { ...payload, reason: value });
    request$.subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
        // Duyệt hoặc ẩn một đánh giá làm đổi số liệu, nên đây là một trong số ít chỗ
        // cần tính lại.
        this.loadCounts();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Review comment field used by vanilla `reviews.js`.
   */
  commentOf(row: AdminReviewRow): string {
    return row.comment || row.content || '—';
  }

  /**
   * Product title used by the original table.
   */
  productName(row: AdminReviewRow): string {
    return row.product?.name || row.product_name || '—';
  }

  /**
   * Product SKU used by the original table.
   */
  productSku(row: AdminReviewRow): string {
    return row.product?.sku || row.product_id || '';
  }

  /**
   * Star label used by the original snippet.
   */
  stars(row: AdminReviewRow): string {
    return adminStars(row.rating);
  }

  /**
   * Status badge text.
   */
  statusLabel(status: string | undefined): string {
    return statusLabelFrom(REVIEW_STATUS_LABELS, status);
  }

  /**
   * Formats a review timestamp.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Modal title for the original review actions.
   */
  actionTitle(): string {
    const type = this.actionType();
    if (type === 'approve') {
      return 'Phê duyệt đánh giá';
    }
    if (type === 'unhide') {
      return 'Mở ẩn đánh giá';
    }
    if (type === 'hide') {
      return 'Ẩn đánh giá';
    }
    if (type === 'reply') {
      return 'Phản hồi đánh giá';
    }
    return 'Tạo ticket CSKH';
  }

  /**
   * Stringifies an audit payload.
   */
  jsonValue(value: unknown): string {
    return JSON.stringify(value || {});
  }
}
