import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { CreateReviewPayload, UserReviewItem } from '../models/review.interface';
import { ApiService } from './api.service';

/**
 * Reviews service for storefront user interactions.
 */
@Injectable({ providedIn: 'root' })
export class ReviewsService {
  private readonly api = inject(ApiService);

  /**
   * Fetches reviews submitted by current user.
   */
  getMyReviews(): Observable<{ success: boolean; reviews: UserReviewItem[] }> {
    return this.api.get<{ success: boolean; reviews: UserReviewItem[] }>('/api/user/reviews');
  }

  /**
   * Submits a new product review for a delivered order.
   */
  submitReview(payload: CreateReviewPayload): Observable<{ success: boolean; review: UserReviewItem }> {
    return this.api.post<{ success: boolean; review: UserReviewItem }>('/api/user/reviews', payload);
  }

  /**
   * Adds customer reply to an existing review thread.
   */
  replyReview(reviewId: string, replyText: string): Observable<{ success: boolean; review: UserReviewItem }> {
    return this.api.post<{ success: boolean; review: UserReviewItem }>(`/api/user/reviews/${reviewId}/reply`, {
      reply_text: replyText,
    });
  }
}
