import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type Params, RouterLink } from '@angular/router';
import { firstValueFrom, of, type Subscription } from 'rxjs';
import { UserReviewItem } from '../../core/models/review.interface';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ReviewsService } from '../../core/services/reviews.service';
import { useBodyClass } from '../../core/utils/body-class';
import { formatVnd, toPublicAsset } from '../../core/utils/money';

/** A delivered item selected from the customer's actual order history. */
interface EligibleItem {
  orderId: string;
  orderCode: string;
  deliveredDate?: string;
  productId: string;
  productName: string;
  productImage?: string;
  unitPrice: number;
}

/** Order projection used to determine which products may be reviewed. */
interface ReviewableOrder {
  order_id: string;
  order_code?: string;
  status: string;
  updated_at?: string;
  created_at?: string;
  items?: Array<{ product_id: string; product_name?: string; product_image?: string; unit_price?: number }>;
}

const PRESET_TAGS = [
  'Đúng mô tả',
  'Chất vải đẹp',
  'Form dáng chuẩn',
  'Giao hàng nhanh',
  'Đóng gói cẩn thận',
  'Tôn dáng',
  'Vải mát mịn',
];

const GUEST_PHONE_KEY = 'velura_guest_review_phone';
const GUEST_TOKEN_KEY = 'velura_guest_review_token';

/**
 * Product review page allowing customers to submit reviews for delivered items
 * and track review status & replies, supporting both member login and verified guest phone flow.
 */
@Component({
  selector: 'app-account-reviews-page',
  imports: [DatePipe, RouterLink],
  host: { class: 'page-product-review' },
  templateUrl: './reviews.page.html',
})
export class AccountReviewsPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly reviewsService = inject(ReviewsService);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private historyRequest?: Subscription;
  private eligibleRequest?: Subscription;

  readonly activeTab = signal<'write' | 'history'>('write');
  readonly presetTags = PRESET_TAGS;

  // Authentication & Guest Phone Verification state
  readonly isLoggedIn = computed(() => !!this.auth.session());
  readonly guestPhone = signal<string>('');
  readonly guestEmail = signal<string>('');
  readonly guestOtpSent = signal<boolean>(false);
  readonly guestOtp = signal<string>('');
  readonly guestChallengeId = signal<string>('');
  readonly sendingOtp = signal<boolean>(false);
  readonly verifyingOtp = signal<boolean>(false);
  readonly guestToken = signal<string>('');
  readonly guestVerifiedPhone = signal<string>('');
  readonly guestAuthError = signal<string>('');
  readonly guestAuthSuccess = signal<string>('');

  readonly isGuestVerified = computed(() => !this.isLoggedIn() && !!this.guestToken() && !!this.guestVerifiedPhone());
  readonly isAuthenticated = computed(() => this.isLoggedIn() || this.isGuestVerified());
  readonly customerDisplayName = computed(() => {
    if (this.isLoggedIn()) {
      return this.auth.session()?.fullName || this.auth.session()?.email || 'Thành viên Velura';
    }
    if (this.isGuestVerified()) {
      return `Khách hàng (${this.maskPhone(this.guestVerifiedPhone())})`;
    }
    return '';
  });

  // Selected product / order to review
  readonly orderId = signal<string>('');
  readonly productId = signal<string>('');
  readonly productName = signal<string>('Sản phẩm Velura');
  readonly productPrice = signal<number>(0);
  readonly productImage = signal<string>('/assets/images/placeholder.jpg');

  // Form signals
  readonly rating = signal<number>(5);
  readonly hoverRating = signal<number>(0);
  readonly selectedTags = signal<string[]>([]);
  readonly comment = signal<string>('');
  readonly imageUrlInput = signal<string>('');
  readonly images = signal<string[]>([]);
  readonly showUrlInput = signal<boolean>(false);

  // File upload state
  readonly uploadingCount = signal<number>(0);
  readonly isDragging = signal<boolean>(false);

  readonly submitting = signal<boolean>(false);
  readonly submitSuccess = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);

  // History signals
  readonly myReviews = signal<UserReviewItem[]>([]);
  readonly loadingReviews = signal<boolean>(false);
  readonly historyError = signal('');

  // Delivered items pending review
  readonly eligibleItems = signal<EligibleItem[]>([]);
  readonly loadingEligible = signal<boolean>(false);
  readonly eligibleError = signal('');

  // Customer reply state
  readonly replyingReviewId = signal<string | null>(null);
  readonly replyText = signal<string>('');
  readonly sendingReply = signal<boolean>(false);

  readonly effectiveRating = computed(() => this.hoverRating() || this.rating());

  constructor() {
    useBodyClass('page-product-review');
  }

  ngOnInit(): void {
    // Restore guest session if available in sessionStorage
    this.restoreGuestSession();

    const qp$ = this.route.queryParams || of({});
    qp$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params: Params) => {
      if (params && params['order_id'] && params['product_id']) {
        this.orderId.set(params['order_id']);
        this.productId.set(params['product_id']);
        if (params['name']) this.productName.set(params['name']);
        if (params['price']) this.productPrice.set(Number(params['price']) || 0);
        if (params['image']) this.productImage.set(toPublicAsset(params['image'], '/assets/images/placeholder.jpg'));
        this.activeTab.set('write');
      }

      if (this.isAuthenticated()) {
        this.loadEligibleItems();
        this.loadReviews();
      }
    });
  }

  /** Restore existing guest verification token and phone number from browser session */
  private restoreGuestSession(): void {
    try {
      const storedPhone = sessionStorage.getItem(GUEST_PHONE_KEY);
      const storedToken = sessionStorage.getItem(GUEST_TOKEN_KEY);
      const proofToken = this.reviewsService.getProofToken();

      const activeToken = storedToken || proofToken || '';
      if (storedPhone && activeToken) {
        this.guestVerifiedPhone.set(storedPhone);
        this.guestPhone.set(storedPhone);
        this.guestToken.set(activeToken);
      }
    } catch {
      /* ignore storage errors */
    }
  }

  /** Mask phone number for display e.g. 098****123 */
  maskPhone(phone: string): string {
    const p = phone.trim();
    if (p.length < 7) return p;
    return `${p.slice(0, 3)}****${p.slice(-3)}`;
  }

  /** Send OTP challenge to guest phone with demo email fallback */
  async sendGuestOtp(): Promise<void> {
    const rawPhone = this.guestPhone().trim();
    if (!rawPhone || !/^(0|\+84)(3|5|7|8|9)\d{8}$/.test(rawPhone)) {
      this.guestAuthError.set('Vui lòng nhập số điện thoại Việt Nam hợp lệ (10 chữ số).');
      return;
    }

    this.sendingOtp.set(true);
    this.guestAuthError.set('');
    this.guestAuthSuccess.set('');

    try {
      const res = await firstValueFrom(
        this.api.post<{
          success?: boolean;
          masked_phone?: string;
          masked_email?: string;
          channel?: string;
          challenge_id?: string;
          message?: string;
        }>('/api/user/orders/track-otp-send', {
          phone: rawPhone,
          email: this.guestEmail().trim() || undefined,
        })
      );

      if (!res.success) {
        throw new Error(res.message || 'Chưa gửi được mã OTP. Vui lòng thử lại.');
      }

      this.guestOtpSent.set(true);
      this.guestChallengeId.set(res.challenge_id || rawPhone);

      const targetDesc = res.masked_email
        ? `qua SMS và Email demo (${res.masked_email})`
        : 'qua tin nhắn SMS (mô phỏng)';
      this.guestAuthSuccess.set(`Mã OTP đã được gửi ${targetDesc}. Vui lòng kiểm tra mã xác thực gồm 6 chữ số.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Không thể gửi mã xác thực. Vui lòng kiểm tra lại.';
      this.guestAuthError.set(msg);
    } finally {
      this.sendingOtp.set(false);
    }
  }

  /** Verify the 6-digit OTP and activate guest review capability */
  async verifyGuestOtp(): Promise<void> {
    const otp = this.guestOtp().trim();
    const phone = this.guestPhone().trim();

    if (!otp || !/^\d{6}$/.test(otp)) {
      this.guestAuthError.set('Vui lòng nhập đầy đủ 6 chữ số mã OTP.');
      return;
    }

    this.verifyingOtp.set(true);
    this.guestAuthError.set('');
    this.guestAuthSuccess.set('');

    try {
      const res = await firstValueFrom(
        this.api.post<{
          success?: boolean;
          phone?: string;
          guest_access_token?: string;
          message?: string;
        }>('/api/user/orders/track-otp-verify', {
          phone,
          otp_code: otp,
        })
      );

      if (!res.success || !res.guest_access_token) {
        throw new Error(res.message || 'Mã OTP không hợp lệ hoặc đã hết hạn.');
      }

      const token = res.guest_access_token;
      const verifiedPhone = res.phone || phone;

      this.guestToken.set(token);
      this.guestVerifiedPhone.set(verifiedPhone);

      try {
        sessionStorage.setItem(GUEST_PHONE_KEY, verifiedPhone);
        sessionStorage.setItem(GUEST_TOKEN_KEY, token);
      } catch {
        /* ignore */
      }

      this.guestAuthSuccess.set('Xác thực số điện thoại thành công! Đang tải danh sách đơn hàng đã nhận...');
      this.loadEligibleItems();
      this.loadReviews();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Xác thực OTP thất bại. Vui lòng thử lại.';
      this.guestAuthError.set(msg);
    } finally {
      this.verifyingOtp.set(false);
    }
  }

  /** Reset guest verification to test with another phone number */
  resetGuestAuth(): void {
    this.guestOtpSent.set(false);
    this.guestOtp.set('');
    this.guestToken.set('');
    this.guestVerifiedPhone.set('');
    this.guestAuthError.set('');
    this.guestAuthSuccess.set('');
    this.eligibleItems.set([]);
    this.myReviews.set([]);
    this.orderId.set('');
    this.productId.set('');
    this.reviewsService.clearGuestProof();

    try {
      sessionStorage.removeItem(GUEST_PHONE_KEY);
      sessionStorage.removeItem(GUEST_TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Reload moderation history */
  loadReviews(): void {
    if (!this.isAuthenticated()) {
      this.myReviews.set([]);
      this.loadingReviews.set(false);
      return;
    }

    this.historyRequest?.unsubscribe();
    this.loadingReviews.set(true);
    this.historyError.set('');

    const token = this.guestToken();
    const endpoint = !this.isLoggedIn() && token
      ? `/api/user/reviews?guest_access_token=${encodeURIComponent(token)}`
      : '/api/user/reviews';

    this.historyRequest = this.api
      .get<{ success?: boolean; reviews?: UserReviewItem[] }>(endpoint)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.myReviews.set(res.reviews || []);
          this.loadingReviews.set(false);
        },
        error: (error: Error) => {
          this.loadingReviews.set(false);
          this.historyError.set(error.message || 'Chưa tải được lịch sử đánh giá.');
        },
      });
  }

  /** Read delivered products from orders (member or guest session) */
  loadEligibleItems(): void {
    if (!this.isAuthenticated()) {
      this.eligibleItems.set([]);
      this.loadingEligible.set(false);
      return;
    }

    this.eligibleRequest?.unsubscribe();
    this.loadingEligible.set(true);
    this.eligibleError.set('');

    const endpoint = this.isLoggedIn()
      ? '/api/user/orders'
      : `/api/user/orders/guest?guest_access_token=${encodeURIComponent(this.guestToken())}`;

    this.eligibleRequest = this.api
      .get<{ orders?: ReviewableOrder[] }>(endpoint)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          const items: EligibleItem[] = [];
          const deliveredOrders = (data.orders || []).filter((o) => o.status === 'delivered');

          for (const order of deliveredOrders) {
            for (const it of order.items || []) {
              if (items.some((item) => item.orderId === order.order_id && item.productId === it.product_id)) continue;
              items.push({
                orderId: order.order_id,
                orderCode: order.order_code || order.order_id,
                deliveredDate: order.updated_at || order.created_at,
                productId: it.product_id,
                productName: it.product_name || 'Sản phẩm Velura',
                productImage: toPublicAsset(it.product_image, '/assets/images/placeholder.jpg'),
                unitPrice: it.unit_price || 0,
              });
            }
          }

          this.eligibleItems.set(items);
          this.loadingEligible.set(false);

          // If no product is selected yet and we have eligible items, select the first one
          const currentPId = this.productId();
          const currentOId = this.orderId();
          const selected = items.find((item) => item.orderId === currentOId && item.productId === currentPId);
          if (selected || items.length > 0) {
            this.selectItem(selected || items[0]);
          } else {
            this.orderId.set('');
            this.productId.set('');
          }
        },
        error: (error: Error) => {
          this.loadingEligible.set(false);
          this.eligibleError.set(error.message || 'Chưa tải được danh sách đơn hàng đã giao.');
        },
      });
  }

  /** Start a fresh review when customer changes selected delivered product */
  selectItem(item: EligibleItem): void {
    this.rating.set(5);
    this.hoverRating.set(0);
    this.comment.set('');
    this.images.set([]);
    this.selectedTags.set([]);
    this.orderId.set(item.orderId);
    this.productId.set(item.productId);
    this.productName.set(item.productName);
    this.productPrice.set(item.unitPrice);
    if (item.productImage) {
      this.productImage.set(item.productImage);
    }
    this.activeTab.set('write');
    this.submitSuccess.set(null);
    this.submitError.set(null);
  }

  setRating(value: number): void {
    this.rating.set(value);
  }

  setHoverRating(value: number): void {
    this.hoverRating.set(value);
  }

  toggleTag(tag: string): void {
    const current = this.selectedTags();
    if (current.includes(tag)) {
      this.selectedTags.set(current.filter((t) => t !== tag));
    } else {
      this.selectedTags.set([...current, tag]);
    }
  }

  /** Handle file input selection */
  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input?.files && input.files.length > 0) {
      void this.processFiles(Array.from(input.files));
      input.value = ''; // Reset input to allow re-selecting the same file
    }
  }

  /** Handle drag and drop */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      void this.processFiles(Array.from(event.dataTransfer.files));
    }
  }

  /** Process and upload image files */
  async processFiles(files: File[]): Promise<void> {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      this.submitError.set('Vui lòng chỉ tải lên tệp định dạng hình ảnh (JPG, PNG, WebP, GIF).');
      return;
    }

    const currentCount = this.images().length;
    if (currentCount + imageFiles.length > 5) {
      this.submitError.set(`Bạn chỉ có thể đính kèm tối đa 5 hình ảnh (Hiện có: ${currentCount}).`);
      return;
    }

    this.submitError.set(null);
    this.uploadingCount.set(imageFiles.length);

    for (const file of imageFiles) {
      if (file.size > 10 * 1024 * 1024) {
        this.submitError.set(`Tệp "${file.name}" vượt quá kích thước tối đa 10MB.`);
        continue;
      }

      try {
        const uploadedUrl = await this.uploadSingleImage(file);
        if (uploadedUrl && !this.images().includes(uploadedUrl)) {
          this.images.set([...this.images(), uploadedUrl]);
        }
      } catch {
        // Fallback: Read as data URL so user experience is not blocked
        try {
          const dataUrl = await this.readFileAsDataUrl(file);
          if (dataUrl && !this.images().includes(dataUrl)) {
            this.images.set([...this.images(), dataUrl]);
          }
        } catch {
          this.submitError.set(`Không thể đọc ảnh "${file.name}". Vui lòng thử lại.`);
        }
      }
    }

    this.uploadingCount.set(0);
  }

  /** Upload single image to /api/user/upload/evidence */
  private async uploadSingleImage(file: File): Promise<string> {
    const formData = new FormData();
    formData.append('file', file);

    const token = this.guestToken();
    const endpoint = !this.isLoggedIn() && token
      ? `/api/user/upload/evidence?guest_access_token=${encodeURIComponent(token)}`
      : '/api/user/upload/evidence';

    const res = await firstValueFrom(
      this.api.post<{ success?: boolean; url?: string }>(endpoint, formData)
    );

    if (res?.url) return res.url;
    throw new Error('Upload returned no URL');
  }

  /** Fallback reader for offline / local preview */
  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** Optional manual image URL addition */
  addImage(): void {
    const url = this.imageUrlInput().trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid URL');
    } catch {
      this.submitError.set('Vui lòng nhập đường dẫn ảnh HTTPS hợp lệ.');
      return;
    }
    if (this.images().length >= 5) {
      this.submitError.set('Mỗi đánh giá được đính kèm tối đa 5 ảnh.');
      return;
    }
    if (url && !this.images().includes(url)) {
      this.images.set([...this.images(), url]);
      this.imageUrlInput.set('');
    }
  }

  removeImage(index: number): void {
    const next = [...this.images()];
    next.splice(index, 1);
    this.images.set(next);
  }

  /** Submit review for delivered product */
  submitReview(): void {
    if (this.submitting() || this.loadingEligible()) return;
    const pId = this.productId();
    const oId = this.orderId();
    const r = this.rating();

    if (!this.isAuthenticated()) {
      this.submitError.set('Vui lòng đăng nhập hoặc xác thực số điện thoại để gửi đánh giá.');
      return;
    }

    if (!pId || !oId || !this.eligibleItems().some((item) => item.orderId === oId && item.productId === pId)) {
      this.submitError.set('Vui lòng chọn sản phẩm và đơn hàng cần đánh giá.');
      return;
    }

    if (!r || r < 1 || r > 5) {
      this.submitError.set('Vui lòng chọn số sao đánh giá (1 - 5 sao).');
      return;
    }

    this.submitting.set(true);
    this.submitError.set(null);
    this.submitSuccess.set(null);

    const payload = {
      product_id: pId,
      order_id: oId,
      rating: r,
      comment: this.comment().trim(),
      images: this.images(),
      review_tags: this.selectedTags(),
      ...(!this.isLoggedIn() && this.guestToken() ? { guest_access_token: this.guestToken() } : {}),
    };

    const endpoint = !this.isLoggedIn() && this.guestToken()
      ? `/api/user/reviews?guest_access_token=${encodeURIComponent(this.guestToken())}`
      : '/api/user/reviews';

    this.api
      .post<{ success: boolean; review: UserReviewItem }>(endpoint, payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.submitSuccess.set(
            res.review.status === 'approved'
              ? 'Cảm ơn bạn! Đánh giá đã được ghi nhận và phê duyệt thành công.'
              : 'Cảm ơn bạn! Đánh giá đã được ghi nhận và đang chờ duyệt.'
          );
          this.comment.set('');
          this.images.set([]);
          this.selectedTags.set([]);
          this.loadReviews();
        },
        error: (err: Error) => {
          this.submitting.set(false);
          const msg =
            err?.message ||
            'Không thể gửi đánh giá. Vui lòng kiểm tra lại đơn hàng hoặc thử lại sau.';
          this.submitError.set(msg);
        },
      });
  }

  openReply(reviewId: string): void {
    this.replyingReviewId.set(reviewId);
    this.replyText.set('');
  }

  sendCustomerReply(reviewId: string): void {
    const text = this.replyText().trim();
    if (!text || this.sendingReply()) return;

    this.sendingReply.set(true);
    const token = this.guestToken();
    const endpoint = `/api/user/reviews/${reviewId}/reply`;
    const body = {
      reply_text: text,
      ...(!this.isLoggedIn() && token ? { guest_access_token: token } : {}),
    };

    this.api.post<{ success: boolean; review: UserReviewItem }>(endpoint, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.sendingReply.set(false);
          this.replyingReviewId.set(null);
          this.replyText.set('');
          this.loadReviews();
        },
        error: () => {
          this.sendingReply.set(false);
        },
      });
  }

  parseReplies(adminReply: string | null | undefined): Array<{ user_name: string; role: string; reply_text: string }> {
    if (!adminReply) return [];
    try {
      const parsed: unknown = JSON.parse(adminReply);
      if (Array.isArray(parsed)) {
        return parsed.filter((item: unknown): item is { user_name: string; role: string; reply_text: string } => {
          if (!item || typeof item !== 'object') return false;
          const reply = item as Record<string, unknown>;
          return typeof reply['user_name'] === 'string' && typeof reply['role'] === 'string' && typeof reply['reply_text'] === 'string';
        });
      }
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    } catch {
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    }
  }

  money(amount: number | undefined): string {
    return formatVnd(amount || 0);
  }
}
