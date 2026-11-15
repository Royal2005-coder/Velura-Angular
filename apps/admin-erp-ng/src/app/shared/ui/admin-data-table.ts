import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { AdminBadgeTone } from './admin-status-badge';
import { AdminErpStatusBadge } from './admin-status-badge';
import { AdminErpEmptyState } from './admin-empty-state';
import { AdminErpTableSkeleton } from './admin-table-skeleton';

export interface AdminTableCellBadge {
  label: string;
  tone: AdminBadgeTone;
}

export interface AdminTableColumn {
  key: string;
  label: string;
  value: (row: unknown) => string;
  badge?: (row: unknown) => AdminTableCellBadge | null;
  /** Resolves a thumbnail URL for the cell; the column then renders image plus text. */
  image?: (row: unknown) => string;
  /** Optional aspect ratio for column image: '1:1' (default) or '16:9' (banners/covers). */
  imageRatio?: '1:1' | '16:9';
  /** Resolves multiple image thumbnails (e.g. customer attachments in reviews), clickable for lightbox. */
  images?: (row: unknown) => readonly string[];
  /** Resolves numeric stars (1-5) for visual star rendering. */
  stars?: (row: unknown) => number | null;
  mono?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Max cell width (e.g. '280px'); longer text is ellipsised and shown in full on hover/focus via title. */
  truncate?: string;
  /** Optional multi-line clamping (default single line nowrap when truncate is set, or 2 lines when lineClamp=2). */
  lineClamp?: number;
}

/** A quick action shown at the end of a row, so routine next steps don't require opening the detail drawer. */
export interface AdminTableRowAction {
  /** Verb naming the action ("Duyệt", "Ẩn"), also used as the accessible name. */
  label: string;
  /** `primary` for the row's main next step, `danger` for destructive ones. */
  tone?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  run: () => void;
}

/**
 * Dense server-paged table with honest loading, empty and error states.
 * Cell values are prepared by the page ViewModel; templates never filter/sort rows.
 */
@Component({
  selector: 'app-erp-data-table',
  imports: [AdminErpStatusBadge, AdminErpEmptyState, AdminErpTableSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading() && !rows().length) {
      <app-erp-table-skeleton [rows]="6" [columns]="columns().length" />
    } @else if (error()) {
      <app-erp-empty-state [title]="errorTitle()" [message]="error()" icon="alert" tone="error">
        <button class="erp-btn erp-btn--primary" type="button" (click)="retry.emit()">Thử lại</button>
      </app-erp-empty-state>
    } @else if (!rows().length) {
      <app-erp-empty-state [title]="emptyTitle()" [message]="emptyMessage()" icon="log">
        @if (emptyActionLabel()) {
          <button class="erp-btn erp-btn--sm" type="button" (click)="emptyAction.emit()">{{ emptyActionLabel() }}</button>
        }
      </app-erp-empty-state>
    } @else {
      <div class="table-shell" [attr.aria-busy]="loading()">
        @if (loading()) {
          <div class="table-busy" role="status">
            <span class="table-busy__spinner" aria-hidden="true"></span>
            Đang tải…
          </div>
        }
        <div class="table-wrap">
        <table>
          <caption class="erp-sr-only">{{ caption() }}</caption>
          <thead>
            <tr>
              @for (column of columns(); track column.key) {
                <th
                  scope="col"
                  [style.width]="column.width"
                  [class.is-right]="column.align === 'right'"
                  [class.is-center]="column.align === 'center'"
                >
                  {{ column.label }}
                </th>
              }
              @if (rowActions()) {
                <th scope="col" class="is-right col-actions"><span class="erp-sr-only">Thao tác</span></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track trackRow(row, $index)) {
              <tr
                [class.is-clickable]="clickable()"
                [attr.tabindex]="clickable() ? 0 : null"
                [attr.aria-haspopup]="clickable() ? 'dialog' : null"
                (click)="select(row)"
                (keydown.enter)="select(row)"
                (keydown.space)="selectFromKeyboard($event, row)"
                (keydown.arrowdown)="moveFocus($event, 1)"
                (keydown.arrowup)="moveFocus($event, -1)"
              >
                @for (column of columns(); track column.key) {
                  <td
                    [class.is-right]="column.align === 'right'"
                    [class.is-center]="column.align === 'center'"
                    [class.is-mono]="column.mono"
                    [class.is-truncated]="!!column.truncate"
                    [style.max-width]="column.truncate"
                    [attr.title]="column.truncate ? column.value(row) : null"
                  >
                    @if (badgeFor(column, row); as badge) {
                      <app-erp-status-badge [label]="badge.label" [tone]="badge.tone" [dot]="true" />
                    } @else if (imagesFor(column, row); as gallery) {
                      @if (gallery.length) {
                        <div class="cell-gallery">
                          @for (img of gallery; track img; let idx = $index) {
                            @if (idx < 3) {
                              <button type="button" class="gallery-thumb-btn" (click)="$event.stopPropagation(); imageClick.emit(img)" title="Xem ảnh">
                                <img [src]="img" alt="Ảnh đính kèm" class="gallery-thumb" loading="lazy" />
                              </button>
                            }
                          }
                          @if (gallery.length > 3) {
                            <span class="gallery-more">+{{ gallery.length - 3 }}</span>
                          }
                        </div>
                      } @else {
                        <span class="cell-empty-dash">—</span>
                      }
                    } @else if (starsFor(column, row); as rating) {
                      <span class="cell-stars" [attr.aria-label]="rating + ' sao'">
                        <span class="cell-stars__icons">
                          @for (star of [1, 2, 3, 4, 5]; track star) {
                            <span class="star-icon" [class.is-filled]="star <= rating">★</span>
                          }
                        </span>
                        <span class="cell-stars__val">{{ rating }}.0</span>
                      </span>
                    } @else if (imageFor(column, row); as thumb) {
                      <span class="cell-media" [class.cell-media--16-9]="column.imageRatio === '16:9'">
                        <img [src]="thumb" alt="" loading="lazy" />
                        <span class="cell-media__text">{{ column.value(row) }}</span>
                      </span>
                    } @else {
                      <span [class.cell-clamped]="column.lineClamp === 2">{{ column.value(row) }}</span>
                    }
                  </td>
                }
                @if (rowActions(); as actionsFor) {
                  <td class="is-right col-actions" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
                    <span class="row-actions">
                      @for (action of actionsFor(row); track action.label) {
                        <button
                          type="button"
                          class="erp-btn erp-btn--sm"
                          [class.erp-btn--primary]="action.tone === 'primary'"
                          [class.erp-btn--ghost]="!action.tone || action.tone === 'ghost'"
                          [class.erp-btn--danger]="action.tone === 'danger'"
                          [disabled]="action.disabled || loading()"
                          (click)="action.run()"
                        >
                          {{ action.label }}
                        </button>
                      }
                    </span>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
      </div>
    }
  `,
  styles: [
    `
      .table-wrap {
        overflow-x: auto;
      }
      .table-shell {
        position: relative;
      }
      .table-busy {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: color-mix(in srgb, var(--erp-surface) 68%, transparent);
        color: var(--erp-muted);
        font-size: 12px;
        cursor: progress;
      }
      .table-busy__spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--erp-line);
        border-top-color: var(--erp-accent);
        border-radius: 50%;
        animation: table-spin 700ms linear infinite;
      }
      @keyframes table-spin {
        to {
          transform: rotate(360deg);
        }
      }
      table {
        width: 100%;
        min-width: 760px;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 12px 16px;
        border-bottom: 1px solid var(--erp-line-subtle);
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      th {
        position: sticky;
        top: 0;
        z-index: 1;
        height: 44px;
        padding-block: 0;
        background: var(--erp-surface);
        box-shadow: inset 0 -1px 0 var(--erp-line);
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border-bottom: 1px solid var(--erp-line);
      }
      td {
        color: var(--erp-text);
        font-size: 14px;
        font-family: inherit;
        font-variant-numeric: tabular-nums;
        transition: background 100ms ease;
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      tbody tr:hover td {
        background: var(--erp-surface-muted);
      }
      tr.is-clickable {
        cursor: pointer;
      }
      tr.is-clickable:focus-visible {
        outline: 2px solid var(--erp-rose);
        outline-offset: -2px;
      }
      .is-right {
        text-align: right;
      }
      .is-center {
        text-align: center;
      }
      .is-truncated {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .col-actions {
        width: 1%;
        padding-block: 6px;
      }
      .row-actions {
        display: inline-flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .is-mono {
        font-variant-numeric: tabular-nums;
      }
      .cell-media {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .cell-media img {
        width: 34px;
        height: 34px;
        flex: 0 0 34px;
        object-fit: cover;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .cell-media--16-9 img {
        width: 68px;
        height: 38px;
        flex: 0 0 68px;
        aspect-ratio: 16 / 9;
        border-radius: 6px;
      }
      .cell-media__text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cell-gallery {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .gallery-thumb-btn {
        padding: 0;
        margin: 0;
        border: 1px solid var(--erp-line);
        border-radius: 6px;
        background: var(--erp-surface-muted);
        cursor: pointer;
        overflow: hidden;
        display: inline-flex;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .gallery-thumb-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        border-color: var(--erp-accent);
      }
      .gallery-thumb {
        width: 34px;
        height: 34px;
        object-fit: cover;
        display: block;
      }
      .gallery-more {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
        font-size: 10.5px;
        font-weight: 700;
        border: 1px solid var(--erp-line);
      }
      .cell-stars {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .cell-stars__icons {
        display: inline-flex;
        gap: 1px;
        font-size: 13px;
        color: #d1d5db;
        line-height: 1;
      }
      .cell-stars__icons .star-icon.is-filled {
        color: #f59e0b;
      }
      .cell-stars__val {
        font-size: 12px;
        font-weight: 700;
        color: var(--erp-text);
      }
      .cell-empty-dash {
        color: var(--erp-muted);
      }
      .cell-clamped {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        white-space: normal;
        line-height: 1.42;
        word-break: break-word;
      }
    `,
  ],
})
export class AdminErpDataTable {
  readonly columns = input.required<readonly AdminTableColumn[]>();
  readonly rows = input.required<readonly unknown[]>();
  readonly loading = input(false);
  readonly error = input('');
  readonly errorTitle = input('Không tải được dữ liệu');
  readonly emptyTitle = input('Chưa có dữ liệu');
  readonly emptyMessage = input('');
  readonly caption = input('Danh sách dữ liệu');
  readonly clickable = input(false);
  /** Optional per-row quick actions (≤2 recommended); clicks never open the row drawer. */
  readonly rowActions = input<((row: unknown) => readonly AdminTableRowAction[]) | null>(null);
  /** Optional stable row id, so refreshing a page keeps focus/scroll on the same rows. */
  readonly rowId = input<((row: unknown) => string) | null>(null);
  /** Recovery button in the empty state, e.g. "Xoá bộ lọc" when filters produced no rows. */
  readonly emptyActionLabel = input('');
  readonly emptyAction = output<void>();

  readonly retry = output<void>();
  readonly rowSelected = output<unknown>();
  /** Emits an image URL when clicked in a cell gallery, for opening a full preview lightbox. */
  readonly imageClick = output<string>();

  /**
   * Resolves a badge for one cell, or null when the cell renders as text.
   */
  badgeFor(column: AdminTableColumn, row: unknown): AdminTableCellBadge | null {
    return column.badge ? column.badge(row) : null;
  }

  /**
   * Resolves a thumbnail for one cell, or null when the column carries no image.
   */
  imageFor(column: AdminTableColumn, row: unknown): string | null {
    const url = column.image ? column.image(row) : '';
    return url ? url : null;
  }

  /**
   * Resolves multiple image thumbnails (e.g. customer attachments in reviews).
   */
  imagesFor(column: AdminTableColumn, row: unknown): readonly string[] | null {
    const list = column.images ? column.images(row) : null;
    return Array.isArray(list) && list.length ? list : null;
  }

  /**
   * Resolves a numeric rating for visual star rendering.
   */
  starsFor(column: AdminTableColumn, row: unknown): number | null {
    const s = column.stars ? column.stars(row) : null;
    return typeof s === 'number' && Number.isFinite(s) ? s : null;
  }

  /** Stable identity for row DOM: the table's `rowId`, falling back to position. */
  trackRow(row: unknown, index: number): string | number {
    return this.rowId()?.(row) ?? index;
  }

  /** Up/Down arrows move between rows, so a queue can be worked through from the keyboard. */
  moveFocus(event: Event, step: 1 | -1): void {
    const row = event.currentTarget as HTMLTableRowElement;
    const next = (step === 1 ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  /**
   * Emits the selected row for a detail drawer/modal.
   */
  select(row: unknown): void {
    if (this.clickable()) {
      this.rowSelected.emit(row);
    }
  }

  /**
   * Keyboard activation for a focused row. Space scrolls by default, so it is swallowed.
   */
  selectFromKeyboard(event: Event, row: unknown): void {
    event.preventDefault();
    this.select(row);
  }
}
