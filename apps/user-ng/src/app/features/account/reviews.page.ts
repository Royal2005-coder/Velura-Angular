import { Component, signal } from '@angular/core';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-account-reviews-page',
  host: { class: 'page-product-review' },
  templateUrl: './reviews.page.html',
})
export class AccountReviewsPage {
  readonly rating = signal(0);

  constructor() {
    useBodyClass('page-product-review');
  }

  /**
   * Selects a star value on the original review form.
   */
  setRating(value: number): void {
    this.rating.set(value);
    document.querySelectorAll('.review-rating__star').forEach((node) => {
      const star = Number((node as HTMLElement).getAttribute('data-value') || '0');
      node.classList.toggle('is-active', star <= value);
    });
  }

  /**
   * Reads the original data-value star buttons.
   */
  onStarClick(event: Event): void {
    const star = (event.target as HTMLElement).closest<HTMLElement>('[data-value]');
    const value = Number(star?.getAttribute('data-value') || '0');
    if (value) {
      this.setRating(value);
    }
  }
}
