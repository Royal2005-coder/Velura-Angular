import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import { CreateReviewPayload, UserReviewItem, ReviewOtpChallenge } from '../models/review.interface';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';

interface ReviewProof { token: string; expiresAt: number; }
const PROOF_KEY = 'velura_guest_review_proof';

/**
 * Reviews service for storefront user interactions.
 */
@Injectable({ providedIn: 'root' })
export class ReviewsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly proof = signal<ReviewProof | null>(this.restoreProof());
  private proofVersion = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  /** Account identity used to clear review drafts and ignore another account's pending mutations. */
  readonly customerSession = computed(() => this.auth.session());
  /** Review-only proof never grants order lookup, payment, or a purchased-product badge. */
  readonly guestVerified = computed(() => !!this.proof());

  constructor() {
    let previous = this.auth.session();
    if (previous) this.clearGuestProof();
    effect(() => {
      const current = this.auth.session();
      if (current !== previous) untracked(() => this.clearGuestProof());
      previous = current;
    });
    this.scheduleExpiry();
    this.destroyRef.onDestroy(() => clearTimeout(this.expiryTimer));
  }

  /** Start a review-only phone challenge; expose the real or demo delivery channel to the customer. */
  sendGuestOtp(phone: string, email?: string, fullName?: string): Observable<ReviewOtpChallenge> {
    return defer(() => {
      this.clearGuestProof();
      const version = this.proofVersion;
      const session = this.auth.session();
      return this.api.post<ReviewOtpChallenge>('/api/user/reviews/otp-send', { phone: phone.trim(), email: email?.trim() || undefined, full_name: fullName?.trim() || undefined }).pipe(map((response) => {
        this.assertScope(session, version);
        if (!response.success || !response.challenge_id) throw new Error('Chưa gửi được mã xác thực. Vui lòng thử lại.');
        return response;
      }));
    });
  }

  /** Exchange a valid challenge for a short session proof scoped to guest reviews only. */
  verifyGuestOtp(challengeId: string, otp: string): Observable<void> {
    return defer(() => {
      const version = this.proofVersion;
      const session = this.auth.session();
      if (!challengeId || !/^\d{6}$/.test(otp)) throw new Error('Nhập mã OTP gồm 6 chữ số.');
      return this.api.post<{ success: boolean; guest_review_token?: string; expires_in?: number }>('/api/user/reviews/otp-check', { challenge_id: challengeId, otp_code: otp }).pipe(map((response) => {
        this.assertScope(session, version);
        const seconds = Number(response.expires_in);
        if (!response.success || !response.guest_review_token || !Number.isFinite(seconds) || seconds <= 0 || seconds > 900) throw new Error('Mã xác thực không hợp lệ hoặc đã hết hạn.');
        const proof = { token: response.guest_review_token, expiresAt: Date.now() + seconds * 1000 };
        sessionStorage.setItem(PROOF_KEY, JSON.stringify(proof));
        this.proof.set(proof);
        this.scheduleExpiry();
      }));
    });
  }

  /** Changing the phone or account revokes the review proof and invalidates earlier pending challenges. */
  clearGuestProof(): void {
    this.proofVersion++;
    this.proof.set(null);
    sessionStorage.removeItem(PROOF_KEY);
    clearTimeout(this.expiryTimer);
  }

  /**
   * Fetches reviews submitted by current user or verified phone guest.
   */
  getMyReviews(): Observable<{ success: boolean; reviews: UserReviewItem[] }> {
    return defer(() => {
      const session = this.auth.session();
      const proof = this.proof();
      const path = !session && proof?.token
        ? `/api/user/reviews?guest_access_token=${encodeURIComponent(proof.token)}`
        : '/api/user/reviews';
      return this.api.get<{ success: boolean; reviews: UserReviewItem[] }>(path).pipe(map((response) => {
        this.assertScope(session);
        return response;
      }));
    });
  }

  /** Expose the verified token for guest image evidence uploads */
  getProofToken(): string | null {
    const proof = this.proof();
    return proof && proof.expiresAt > Date.now() ? proof.token : null;
  }

  /**
   * Submit feedback independently of purchase; only server-owned delivered-order facts grant the purchase badge.
   */
  submitReview(payload: CreateReviewPayload): Observable<{ success: boolean; review: UserReviewItem }> {
    return defer(() => {
      const session = this.auth.session();
      const version = this.proofVersion;
      if (!payload.product_id || !Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) throw new Error('Chọn sản phẩm và số sao hợp lệ (1–5).');
      const proof = this.proof();
      if (!session && (!proof || proof.expiresAt <= Date.now())) { this.clearGuestProof(); throw new Error('Xác thực số điện thoại trước khi gửi đánh giá.'); }
      return this.api.post<{ success: boolean; review: UserReviewItem }>('/api/user/reviews', {
        ...payload,
        ...(!session ? { guest_review_token: proof!.token, guest_access_token: proof!.token } : {})
      }).pipe(map((response) => {
        this.assertScope(session, !session ? version : undefined);
        if (!response.success || !response.review) throw new Error('Chưa gửi được đánh giá. Vui lòng thử lại.');
        return response;
      }));
    });
  }

  /**
   * Adds customer reply to an existing review thread.
   */
  replyReview(reviewId: string, replyText: string): Observable<{ success: boolean; review: UserReviewItem }> {
    return defer(() => {
      const session = this.auth.session();
      const proof = this.proof();
      const body = {
        reply_text: replyText,
        ...(!session && proof?.token ? { guest_access_token: proof.token, guest_review_token: proof.token } : {})
      };
      return this.api.post<{ success: boolean; review: UserReviewItem }>(`/api/user/reviews/${reviewId}/reply`, body).pipe(map((response) => {
        this.assertScope(session);
        return response;
      }));
    });
  }

  private assertScope(session: ReturnType<AuthService['session']>, version?: number): void {
    if (session !== this.auth.session() || (version !== undefined && version !== this.proofVersion)) throw new Error('Phiên xác thực đã thay đổi. Vui lòng thử lại.');
  }

  private restoreProof(): ReviewProof | null {
    try {
      const raw = sessionStorage.getItem(PROOF_KEY);
      if (!raw) return null;
      const proof = JSON.parse(raw) as ReviewProof;
      if (typeof proof.token === 'string' && proof.token && Number.isFinite(proof.expiresAt) && proof.expiresAt > Date.now() && proof.expiresAt <= Date.now() + 900000) return proof;
    } catch { /* Discard malformed browser state. */ }
    sessionStorage.removeItem(PROOF_KEY);
    return null;
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    const proof = this.proof();
    if (proof) this.expiryTimer = setTimeout(() => this.clearGuestProof(), Math.max(0, proof.expiresAt - Date.now()));
  }
}
