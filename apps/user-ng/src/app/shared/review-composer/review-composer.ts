import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReviewsService } from '../../core/services/reviews.service';
import type { ProductSummary } from '../../core/models/product.interface';
import type { ReviewOtpChallenge, UserReviewItem } from '../../core/models/review.interface';

/** Product feedback for members and phone-verified guests; purchase facts always come from the server. */
@Component({
  selector: 'app-review-composer',
  imports: [FormsModule],
  templateUrl: './review-composer.html',
  styleUrl: './review-composer.scss',
})
export class ReviewComposer {
  readonly model = inject(ReviewsService);
  private readonly destroyRef = inject(DestroyRef);
  readonly product = input.required<ProductSummary>();
  readonly orderId = input<string | null>(null);
  readonly initialVariantId = input<string | null>(null);
  readonly submitted = output<UserReviewItem>();
  readonly member = computed(() => !!this.model.customerSession());
  readonly busy = signal(false);
  readonly error = signal('');
  readonly success = signal('');
  readonly challenge = signal<ReviewOtpChallenge | null>(null);
  readonly remaining = signal(0);
  readonly cooldown = signal(0);
  readonly score = signal(5);
  readonly stars = [1, 2, 3, 4, 5];
  phone = '';
  email = '';
  fullName = '';
  otp = '';
  comment = '';
  variantId = '';

  constructor() {
    effect(() => {
      const product = this.product();
      const variantId = this.initialVariantId();
      this.model.customerSession();
      untracked(() => {
        this.comment = '';
        this.otp = '';
        this.phone = '';
        this.email = '';
        this.fullName = '';
        this.variantId = product.variants?.some((variant) => variant.variant_id === variantId) ? variantId! : '';
        this.score.set(5);
        this.error.set('');
        this.success.set('');
        this.challenge.set(null);
        this.busy.set(false);
      });
    });
    const timer = setInterval(() => {
      this.remaining.update((value) => Math.max(0, value - 1));
      this.cooldown.update((value) => Math.max(0, value - 1));
    }, 1000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  /** A changed contact must not reuse the previously verified phone or pending challenge. */
  contactChanged(): void {
    this.model.clearGuestProof();
    this.challenge.set(null);
    this.otp = '';
    this.remaining.set(0);
    this.cooldown.set(0);
    this.error.set('');
  }

  /** Start review-only verification and label the backend's actual SMS or SMS-demo channel. */
  sendOtp(): void {
    if (this.busy() || this.cooldown() > 0) return;
    if (!this.phone.trim()) { this.error.set('Nhập số điện thoại để xác thực.'); return; }
    const phone = this.phone;
    const email = this.email;
    const productId = this.product().product_id;
    this.busy.set(true);
    this.error.set('');
    this.model.sendGuestOtp(phone, email, this.fullName).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (phone !== this.phone || email !== this.email || productId !== this.product().product_id) return;
        this.challenge.set(response);
        this.remaining.set(response.expires_in);
        this.cooldown.set(response.expires_in);
        this.otp = '';
        this.busy.set(false);
      }, error: (error: Error) => {
        this.busy.set(false);
        this.error.set(error.message || 'Chưa gửi được mã OTP. Hãy thử lại.');
      },
    });
  }

  /** Confirm the challenge without creating an account or claiming a verified purchase. */
  verifyOtp(): void {
    const challenge = this.challenge();
    if (!challenge || this.busy() || this.remaining() <= 0) return;
    this.busy.set(true);
    this.error.set('');
    this.model.verifyGuestOtp(challenge.challenge_id, this.otp.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.challenge.set(null); },
      error: (error: Error) => { this.busy.set(false); this.error.set(error.message || 'Mã OTP không hợp lệ.'); },
    });
  }

  /** Submit genuine product/variant context once and display only the API's moderation result. */
  submitReview(): void {
    if (this.busy()) return;
    if (!this.member() && !this.model.guestVerified()) { this.error.set('Xác thực số điện thoại trước khi gửi đánh giá.'); return; }
    const product = this.product();
    if (this.variantId && !product.variants?.some((variant) => variant.variant_id === this.variantId)) { this.error.set('Phân loại sản phẩm không hợp lệ.'); return; }
    const session = this.model.customerSession();
    this.busy.set(true);
    this.error.set('');
    this.success.set('');
    this.model.submitReview({ product_id: product.product_id, order_id: this.orderId(), variant_id: this.variantId || null, rating: this.score(), comment: this.comment.trim(), full_name: !this.member() ? this.fullName.trim() || undefined : undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (product.product_id !== this.product().product_id || session !== this.model.customerSession()) return;
        this.busy.set(false);
        this.comment = '';
        this.success.set(response.review.status === 'approved' ? 'Đánh giá đã được đăng. Cảm ơn bạn!' : 'Đánh giá đã được ghi nhận và đang chờ duyệt.');
        this.submitted.emit(response.review);
      }, error: (error: Error) => {
        if (product.product_id !== this.product().product_id || session !== this.model.customerSession()) return;
        this.busy.set(false);
        this.error.set(error.message || 'Chưa gửi được đánh giá. Hãy thử lại.');
      },
    });
  }
}
