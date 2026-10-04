import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type Params, Router, RouterLink } from '@angular/router';
import { of, type Subscription } from 'rxjs';
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

/**
 * Product review page allowing customers to submit reviews for delivered items
 * and track review status & replies.
 */
@Component({
  selector: 'app-account-reviews-page',
  imports: [DatePipe, RouterLink],
  host: { class: 'page-product-review' },
  templateUrl: './reviews.page.html',
})
export class AccountReviewsPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly reviewsService = inject(ReviewsService);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private historyRequest?: Subscription;
  private eligibleRequest?: Subscription;

  readonly activeTab = signal<'write' | 'history'>('write');
  readonly presetTags = PRESET_TAGS;

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

  readonly submitting = signal<boolean>(false);
  readonly submitSuccess = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);

  // History signals
  readonly myReviews = signal<UserReviewItem[]>([]);
  readonly loadingReviews = signal<boolean>(true);
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

  /** Load genuine eligibility for query links and direct account navigation alike. */
  ngOnInit(): void {
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
      this.loadEligibleItems();
    });

    this.loadReviews();
  }

  /** Reload moderation history without presenting transport errors as an empty history. */
  loadReviews(): void {
    this.historyRequest?.unsubscribe();
    this.loadingReviews.set(true);
    this.historyError.set('');
    const userId = this.auth.session()?.userId;
    this.historyRequest = this.reviewsService
      .getMyReviews()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => {
        if (userId !== this.auth.session()?.userId) return;
        this.myReviews.set(res.reviews || []);
        this.loadingReviews.set(false);
      }, error: (error: Error) => {
        if (userId !== this.auth.session()?.userId) return;
        this.loadingReviews.set(false);
        this.historyError.set(error.message || 'Chưa tải được lịch sử đánh giá.');
      } });
  }

  /** Read delivered products and deduplicate variants of the same product on an order. */
  loadEligibleItems(): void {
    this.eligibleRequest?.unsubscribe();
    this.loadingEligible.set(true);
    this.eligibleError.set('');
    const userId = this.auth.session()?.userId;
    this.eligibleRequest = this.api
      .get<{ orders?: ReviewableOrder[] }>('/api/user/orders')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (data) => {
        if (userId !== this.auth.session()?.userId) return;
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
        const selected = items.find((item) => item.orderId === this.orderId() && item.productId === this.productId());
        if (selected || items.length > 0) {
          this.selectItem(selected || items[0]);
        } else {
          this.orderId.set('');
          this.productId.set('');
        }
      }, error: (error: Error) => {
        if (userId !== this.auth.session()?.userId) return;
        this.loadingEligible.set(false);
        this.eligibleError.set(error.message || 'Chưa tải được sản phẩm đã giao.');
      } });
  }

  /** Start a fresh review when the customer changes the selected delivered product. */
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

  /** Choose the review's satisfaction score. */
  setRating(value: number): void {
    this.rating.set(value);
  }

  /** Preview stars without changing the submitted score. */
  setHoverRating(value: number): void {
    this.hoverRating.set(value);
  }

  /** Toggle a customer-selected description of the purchase experience. */
  toggleTag(tag: string): void {
    const current = this.selectedTags();
    if (current.includes(tag)) {
      this.selectedTags.set(current.filter((t) => t !== tag));
    } else {
      this.selectedTags.set([...current, tag]);
    }
  }

  /** Attach at most five HTTPS evidence images. */
  addImage(): void {
    const url = this.imageUrlInput().trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid URL');
    } catch {
      this.submitError.set('Vui lòng nhập đường dẫn ảnh HTTPS hợp lệ.');
      return;
    }
    if (this.images().length >= 5) { this.submitError.set('Mỗi đánh giá được đính kèm tối đa 5 ảnh.'); return; }
    if (url && !this.images().includes(url)) {
      this.images.set([...this.images(), url]);
      this.imageUrlInput.set('');
    }
  }

  /** Remove an image before the review is submitted. */
  removeImage(index: number): void {
    const next = [...this.images()];
    next.splice(index, 1);
    this.images.set(next);
  }

  /** Submit once for a genuinely delivered item, preserving input after errors. */
  submitReview(): void {
    if (this.submitting() || this.loadingEligible()) return;
    const pId = this.productId();
    const oId = this.orderId();
    const r = this.rating();

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

    this.reviewsService
      .submitReview({
        product_id: pId,
        order_id: oId,
        rating: r,
        comment: this.comment().trim(),
        images: this.images(),
        review_tags: this.selectedTags(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.submitSuccess.set(
            res.review.status === 'approved' ? 'Cảm ơn bạn! Đánh giá đã được đăng.' : 'Cảm ơn bạn! Đánh giá đã được ghi nhận và đang chờ duyệt.'
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

  /** Open the customer's reply editor for a review thread. */
  openReply(reviewId: string): void {
    this.replyingReviewId.set(reviewId);
    this.replyText.set('');
  }

  /** Send a single reply while preventing duplicate submissions. */
  sendCustomerReply(reviewId: string): void {
    const text = this.replyText().trim();
    if (!text || this.sendingReply()) return;

    this.sendingReply.set(true);
    this.reviewsService.replyReview(reviewId, text).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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

  /** Decode historical replies, retaining compatibility with plain text replies. */
  parseReplies(adminReply: string | null | undefined): Array<{ user_name: string; role: string; reply_text: string }> {
    if (!adminReply) return [];
    try {
      const parsed: unknown = JSON.parse(adminReply);
      if (Array.isArray(parsed)) return parsed.filter((item: unknown): item is { user_name: string; role: string; reply_text: string } => {
        if (!item || typeof item !== 'object') return false;
        const reply = item as Record<string, unknown>;
        return typeof reply['user_name'] === 'string' && typeof reply['role'] === 'string' && typeof reply['reply_text'] === 'string';
      });
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    } catch {
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    }
  }

  /** Format item prices consistently with the storefront. */
  money(amount: number | undefined): string {
    return formatVnd(amount || 0);
  }
}
