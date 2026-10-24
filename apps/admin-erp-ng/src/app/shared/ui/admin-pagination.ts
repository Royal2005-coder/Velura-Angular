import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type AdminPageItem = number | '…';

/**
 * Server-paged footer with a compact page window.
 */
@Component({
  selector: 'app-erp-pagination',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="pagination" aria-label="Phân trang">
      <span class="pagination__label">{{ label() }}</span>
      <div class="pagination__buttons">
        <button class="pagination__btn" type="button" [disabled]="page() <= 1" (click)="go(page() - 1)" aria-label="Trang trước">
          ‹
        </button>
        @for (item of items(); track $index) {
          @if (item === '…') {
            <span class="pagination__ellipsis">…</span>
          } @else {
            <button
              class="pagination__btn"
              type="button"
              [class.is-active]="item === page()"
              [attr.aria-current]="item === page() ? 'page' : null"
              (click)="go(item)"
            >
              {{ item }}
            </button>
          }
        }
        <button
          class="pagination__btn"
          type="button"
          [disabled]="page() >= pageCount()"
          (click)="go(page() + 1)"
          aria-label="Trang sau"
        >
          ›
        </button>
      </div>
    </nav>
  `,
  styles: [
    `
      .pagination {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-top: 1px solid var(--erp-line);
      }
      .pagination__label {
        color: var(--erp-muted);
        font-size: 11px;
      }
      .pagination__buttons {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .pagination__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 30px;
        padding: 0 8px;
        border: 1px solid var(--erp-line);
        border-radius: 5px;
        background: var(--erp-surface);
        color: var(--erp-text);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .pagination__btn:hover:not(:disabled) {
        border-color: var(--erp-accent);
      }
      .pagination__btn.is-active {
        border-color: var(--erp-accent);
        background: var(--erp-accent);
        color: #fff;
      }
      .pagination__btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .pagination__ellipsis {
        padding: 0 4px;
        color: var(--erp-soft);
      }
    `,
  ],
})
export class AdminErpPagination {
  readonly page = input.required<number>();
  readonly pageCount = input.required<number>();
  readonly label = input('');
  readonly changed = output<number>();

  readonly items = computed(() => pageWindow(this.pageCount(), this.page()));

  /**
   * Emits a bounded page number.
   */
  go(page: number): void {
    const next = Math.min(Math.max(1, page), Math.max(1, this.pageCount()));
    if (next !== this.page()) {
      this.changed.emit(next);
    }
  }
}

function pageWindow(pageCount: number, current: number): AdminPageItem[] {
  const total = Math.max(1, pageCount);
  const page = Math.min(total, Math.max(1, current));
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const items: AdminPageItem[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(total - 1, page + 1);
  if (start > 2) items.push('…');
  for (let next = start; next <= end; next += 1) items.push(next);
  if (end < total - 1) items.push('…');
  items.push(total);
  return items;
}
