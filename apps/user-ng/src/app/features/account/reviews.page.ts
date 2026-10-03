import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { UserReviewItem } from '../../core/models/review.interface';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ReviewsService } from '../../core/services/reviews.service';
import { useBodyClass } from '../../core/utils/body-class';
import { formatVnd, toPublicAsset } from '../../core/utils/money';

interface EligibleItem {
  orderId: string;
  orderCode: string;
  deliveredDate?: string;
  productId: string;
  productName: string;
  productImage?: string;
  unitPrice: number;
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
  imports: [DatePipe],
  host: { class: 'page-product-review' },
  templateUrl: './reviews.page.html',
})
export class AccountReviewsPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly reviewsService = inject(ReviewsService);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

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

  // Delivered items pending review
  readonly eligibleItems = signal<EligibleItem[]>([]);
  readonly loadingEligible = signal<boolean>(false);

  // Customer reply state
  readonly replyingReviewId = signal<string | null>(null);
  readonly replyText = signal<string>('');
  readonly sendingReply = signal<boolean>(false);

  readonly effectiveRating = computed(() => this.hoverRating() || this.rating());

  constructor() {
    useBodyClass('page-product-review');
  }

  ngOnInit(): void {
    const qp$ = this.route.queryParams || of({});
    qp$.subscribe((params: any) => {
      if (params && params['order_id'] && params['product_id']) {
        this.orderId.set(params['order_id']);
        this.productId.set(params['product_id']);
        if (params['name']) this.productName.set(params['name']);
        if (params['price']) this.productPrice.set(Number(params['price']) || 0);
        if (params['image']) this.productImage.set(toPublicAsset(params['image'], '/assets/images/placeholder.jpg'));
        this.activeTab.set('write');
      } else {
        this.loadReviews();
        this.loadEligibleItems();
      }
    });

    this.loadReviews();
  }

  loadReviews(): void {
    this.loadingReviews.set(true);
    this.reviewsService
      .getMyReviews()
      .pipe(catchError(() => of({ success: false, reviews: [] as UserReviewItem[] })))
      .subscribe((res) => {
        this.myReviews.set(res.reviews || []);
        this.loadingReviews.set(false);
      });
  }

  loadEligibleItems(): void {
    this.loadingEligible.set(true);
    this.api
      .get<{ orders?: any[] }>('/api/user/orders')
      .pipe(catchError(() => of({ orders: [] })))
      .subscribe((data) => {
        const items: EligibleItem[] = [];
        const deliveredOrders = (data.orders || []).filter((o) => o.status === 'delivered');
        for (const order of deliveredOrders) {
          for (const it of order.items || []) {
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
        if (!this.productId() && items.length > 0) {
          this.selectItem(items[0]);
        }
      });
  }

  selectItem(item: EligibleItem): void {
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

  addImage(): void {
    const url = this.imageUrlInput().trim();
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

  submitReview(): void {
    const pId = this.productId();
    const oId = this.orderId();
    const r = this.rating();

    if (!pId || !oId) {
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
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.submitSuccess.set(
            'Cảm ơn bạn! Đánh giá đã được gửi thành công và đang được hệ thống phê duyệt tự động.'
          );
          this.comment.set('');
          this.images.set([]);
          this.selectedTags.set([]);
          this.loadReviews();
        },
        error: (err: any) => {
          this.submitting.set(false);
          const msg =
            err?.message ||
            err?.error?.message ||
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
    if (!text) return;

    this.sendingReply.set(true);
    this.reviewsService.replyReview(reviewId, text).subscribe({
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
      const parsed = JSON.parse(adminReply);
      if (Array.isArray(parsed)) return parsed;
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    } catch {
      return [{ user_name: 'Velura CSKH', role: 'admin', reply_text: adminReply }];
    }
  }

  money(amount: number | undefined): string {
    return formatVnd(amount || 0);
  }
}
