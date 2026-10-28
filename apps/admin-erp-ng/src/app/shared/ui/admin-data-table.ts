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
  mono?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: string;
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
      <app-erp-empty-state [title]="emptyTitle()" [message]="emptyMessage()" icon="log" />
    } @else {
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
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr
                [class.is-clickable]="clickable()"
                [attr.tabindex]="clickable() ? 0 : null"
                [attr.aria-haspopup]="clickable() ? 'dialog' : null"
                (click)="select(row)"
                (keydown.enter)="select(row)"
                (keydown.space)="selectFromKeyboard($event, row)"
              >
                @for (column of columns(); track column.key) {
                  <td
                    [class.is-right]="column.align === 'right'"
                    [class.is-center]="column.align === 'center'"
                    [class.is-mono]="column.mono"
                  >
                    @if (badgeFor(column, row); as badge) {
                      <app-erp-status-badge [label]="badge.label" [tone]="badge.tone" [dot]="true" />
                    } @else if (imageFor(column, row); as thumb) {
                      <span class="cell-media">
                        <img [src]="thumb" alt="" loading="lazy" />
                        <span>{{ column.value(row) }}</span>
                      </span>
                    } @else {
                      {{ column.value(row) }}
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [
    `
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        min-width: 760px;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 10px 14px;
        border-bottom: 1px solid var(--erp-line);
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      td {
        color: var(--erp-text);
        font-size: 12px;
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
        outline: 2px solid var(--erp-accent);
        outline-offset: -2px;
      }
      .is-right {
        text-align: right;
      }
      .is-center {
        text-align: center;
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

  readonly retry = output<void>();
  readonly rowSelected = output<unknown>();

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
