import { Component, computed, input, output } from '@angular/core';
import { adminPageItems } from '../core/admin-format';

/**
 * Original admin list footer: range label + compact page buttons.
 */
@Component({
  selector: 'app-admin-pagination',
  template: `
    <div class="admin-list-footer">
      <p class="admin-table-note">{{ label() }}</p>
      @if (pageCount() > 1) {
        <nav class="admin-pagination">
          <button type="button" [disabled]="page() <= 1" aria-label="Trang trước" (click)="go(page() - 1)">←</button>
          @for (item of items(); track $index) {
            @if (item === '…') {
              <span class="pagination-ellipsis">…</span>
            } @else {
              <button type="button" [class.is-active]="page() === item" (click)="go(item)">{{ item }}</button>
            }
          }
          <button type="button" [disabled]="page() >= pageCount()" aria-label="Trang sau" (click)="go(page() + 1)">→</button>
        </nav>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }
  `,
})
export class AdminPagination {
  readonly page = input.required<number>();
  readonly pageCount = input.required<number>();
  readonly label = input.required<string>();
  readonly changed = output<number>();

  readonly items = computed(() => adminPageItems(this.pageCount(), this.page()));

  /**
   * Emits a clamped page number for the original list footers.
   */
  go(page: number): void {
    const next = Math.min(this.pageCount(), Math.max(1, page));
    if (next !== this.page()) {
      this.changed.emit(next);
    }
  }
}
