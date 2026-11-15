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
      @if (pageSizes().length) {
        <label class="pagination__size">
          <span>Hiển thị</span>
          <select class="erp-select" [value]="pageSize()" (change)="onSize($event)" aria-label="Số dòng mỗi trang">
            @for (size of pageSizes(); track size) {
              <option [value]="size" [selected]="size === pageSize()">{{ size }}</option>
            }
          </select>
        </label>
      }
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
        font-size: 12px;
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
        min-width: 32px;
        height: 32px;
        padding: 0 8px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface);
        color: var(--erp-text);
        font-size: 13px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pagination__btn:hover:not(:disabled) {
        border-color: var(--erp-accent-border);
        background: var(--erp-surface-muted);
        color: var(--erp-accent);
      }
      .pagination__btn.is-active {
        border-color: var(--erp-accent);
        background: var(--erp-accent);
        color: #fff;
      }
      .pagination__btn.is-active:hover:not(:disabled) {
        background: var(--erp-accent-strong);
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
      .pagination__size {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--erp-muted);
      }
      .pagination__size .erp-select {
        width: auto;
        min-height: 30px;
        padding-block: 2px;
      }
    `,
  ],
})
export class AdminErpPagination {
  readonly page = input.required<number>();
  readonly pageCount = input.required<number>();
  readonly label = input('');
  readonly changed = output<number>();
  /** Offer a rows-per-page choice (e.g. [10, 20, 50]); empty hides it. The owner reloads from page 1. */
  readonly pageSizes = input<readonly number[]>([]);
  readonly pageSize = input(0);
  readonly pageSizeChanged = output<number>();

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

  /** Emits the chosen page size when it is one of the offered values. */
  onSize(event: Event): void {
    const size = Number((event.target as HTMLSelectElement).value);
    if (this.pageSizes().includes(size) && size !== this.pageSize()) this.pageSizeChanged.emit(size);
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
