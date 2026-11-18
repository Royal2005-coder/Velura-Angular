import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { AdminBadgeTone, AdminErpStatusBadge } from './admin-status-badge';
import { AdminErpEmptyState } from './admin-empty-state';
import { AdminErpIcon } from './admin-erp-icon';
import { AdminErpTableSkeleton } from './admin-table-skeleton';
import { AdminErpToastService } from './admin-toast';

export interface AdminTableCellBadge {
  label: string;
  tone: AdminBadgeTone;
}

export interface AdminTableCellIcon {
  name: string;
  tone?: AdminBadgeTone | 'accent';
}

export interface AdminTableColumn {
  key: string;
  label: string;
  /** Optional subtle topic icon rendered in the column header (`13px`). */
  icon?: string;
  value: (row: unknown) => string;
  /** Optional muted secondary line rendered beneath the primary text/media value. */
  subtext?: (row: unknown) => string;
  /** Optional semantic topic icon badge rendered beside plain text values. */
  cellIcon?: (row: unknown) => AdminTableCellIcon | null;
  /** Replaces text with a semantic status pill when non-null. */
  badge?: (row: unknown) => AdminTableCellBadge | null;
  /** Renders a secondary pill beside `value(row)` without hiding the primary value (e.g. stock count + low-stock warning). */
  secondaryBadge?: (row: unknown) => AdminTableCellBadge | null;
  /** Resolves a value to copy to clipboard on 1-click inline button (e.g. order code, SKU, voucher code, email). */
  copyValue?: (row: unknown) => string;
  /** Resolves a thumbnail URL for the cell; the column then renders image plus text/subtext. */
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
  minWidth?: string;
  /** Max cell width (e.g. '280px'); longer text is ellipsised and shown in full on hover/focus via title. */
  truncate?: string;
  /** Optional multi-line clamping (default single line nowrap, or 2 lines when lineClamp=2). */
  lineClamp?: number;
}

/** A quick action shown at the end of a row, so routine next steps don't require opening the detail drawer. */
export interface AdminTableRowAction {
  /** Verb naming the action ("Duyệt", "Ẩn"), also used as the accessible name. */
  label: string;
  /** Optional icon inside the quick-action button. */
  icon?: string;
  /** `primary` for the row's main next step, `outline`/`ghost` for secondary, `danger`/`danger-outline` for destructive ones. */
  tone?: 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-outline';
  disabled?: boolean;
  run: () => void;
}

/**
 * Dense SaaS server-paged table with anti-overflow column sizing, topic iconography,
 * 2-line rich cells, 1-click copy-to-clipboard, sticky quick actions, and honest loading/empty/error states.
 */
@Component({
  selector: 'app-erp-data-table',
  imports: [AdminErpStatusBadge, AdminErpEmptyState, AdminErpTableSkeleton, AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading() && !rows().length) {
      <app-erp-table-skeleton [rows]="6" [columns]="columns().length" />
    } @else if (error()) {
      <app-erp-empty-state [title]="errorTitle()" [message]="error()" icon="alert" tone="error">
        <button class="erp-btn erp-btn--primary erp-btn--sm" type="button" (click)="retry.emit()">
          <app-erp-icon name="refresh" [size]="'14'" />
          Thử lại
        </button>
      </app-erp-empty-state>
    } @else if (!rows().length) {
      <app-erp-empty-state [title]="emptyTitle()" [message]="emptyMessage()" [icon]="emptyIcon()">
        @if (emptyActionLabel()) {
          <button class="erp-btn erp-btn--sm" type="button" (click)="emptyAction.emit()">
            <app-erp-icon name="filter-x" [size]="'14'" />
            {{ emptyActionLabel() }}
          </button>
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
                    [style.width]="column.width || null"
                    [style.min-width]="column.minWidth || null"
                    [style.max-width]="column.truncate || column.width || null"
                    [class.is-right]="column.align === 'right'"
                    [class.is-center]="column.align === 'center'"
                  >
                    <span class="th-inner" [class.th-inner--right]="column.align === 'right'" [class.th-inner--center]="column.align === 'center'">
                      @if (column.icon) {
                        <app-erp-icon class="th-icon" [name]="column.icon" [size]="'13'" />
                      }
                      <span>{{ column.label }}</span>
                    </span>
                  </th>
                }
                @if (rowActions()) {
                  <th scope="col" class="is-right col-actions"><span class="erp-sr-only">Thao tác</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track trackRow(row, $index); let rowIdx = $index) {
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
                      [class.is-clamped]="column.lineClamp === 2"
                      [style.width]="column.width || null"
                      [style.min-width]="column.minWidth || null"
                      [style.max-width]="column.truncate || column.width || '340px'"
                      [attr.title]="cellTitle(column, row)"
                    >
                      <div
                        class="cell-box"
                        [class.cell-box--clamped]="column.lineClamp === 2"
                        [class.cell-box--right]="column.align === 'right'"
                        [class.cell-box--center]="column.align === 'center'"
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
                            <span class="cell-media__frame">
                              <img [src]="thumb" alt="" loading="lazy" />
                            </span>
                            <span class="cell-stack">
                              <span class="cell-inline">
                                <span class="cell-media__text">{{ column.value(row) }}</span>
                                @if (copyValueFor(column, row); as copyText) {
                                  <button
                                    type="button"
                                    class="erp-copy-btn cell-copy"
                                    [attr.aria-label]="'Sao chép ' + copyText"
                                    [title]="'Sao chép: ' + copyText"
                                    (click)="copyCell($event, copyText, rowIdx + ':' + column.key)"
                                  >
                                    <app-erp-icon [name]="copiedKey() === rowIdx + ':' + column.key ? 'check' : 'copy'" [size]="'12'" />
                                  </button>
                                }
                              </span>
                              @if (subtextFor(column, row); as sub) {
                                <small class="cell-subtext">{{ sub }}</small>
                              }
                            </span>
                          </span>
                        } @else {
                          <span class="cell-stack" [class.cell-stack--right]="column.align === 'right'">
                            <span class="cell-inline" [class.cell-inline--right]="column.align === 'right'">
                              @if (cellIconFor(column, row); as cIcon) {
                                <span class="cell-topic-icon" [class]="'cell-topic-icon cell-topic-icon--' + (cIcon.tone || 'neutral')">
                                  <app-erp-icon [name]="cIcon.name" [size]="'13'" />
                                </span>
                              }
                              <span class="cell-primary" [class.cell-clamped]="column.lineClamp === 2">{{ column.value(row) }}</span>
                              @if (secondaryBadgeFor(column, row); as secBadge) {
                                <app-erp-status-badge [label]="secBadge.label" [tone]="secBadge.tone" [dot]="true" />
                              }
                              @if (copyValueFor(column, row); as copyText) {
                                <button
                                  type="button"
                                  class="erp-copy-btn cell-copy"
                                  [attr.aria-label]="'Sao chép ' + copyText"
                                  [title]="'Sao chép: ' + copyText"
                                  (click)="copyCell($event, copyText, rowIdx + ':' + column.key)"
                                >
                                  <app-erp-icon [name]="copiedKey() === rowIdx + ':' + column.key ? 'check' : 'copy'" [size]="'12'" />
                                </button>
                              }
                            </span>
                            @if (subtextFor(column, row); as sub) {
                              <small class="cell-subtext">{{ sub }}</small>
                            }
                          </span>
                        }
                      </div>
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
                            [class.erp-btn--danger-outline]="action.tone === 'danger-outline'"
                            [disabled]="action.disabled || loading()"
                            (click)="action.run()"
                          >
                            @if (action.icon) {
                              <app-erp-icon [name]="action.icon" [size]="'13'" />
                            }
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
      .table-shell {
        position: relative;
        min-width: 0;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .table-busy {
        position: absolute;
        inset: 0;
        z-index: 4;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: color-mix(in srgb, var(--erp-surface) 72%, transparent);
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
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
        border-collapse: separate;
        border-spacing: 0;
        table-layout: auto;
      }
      th,
      td {
        padding: 11px 14px;
        border-bottom: 1px solid var(--erp-line-subtle);
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      td.is-clamped {
        white-space: normal;
      }
      th {
        position: sticky;
        top: 0;
        z-index: 2;
        height: 42px;
        padding-block: 0;
        background: #F8FAFC;
        border-bottom: 1px solid var(--erp-line);
        color: var(--erp-muted);
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .th-inner {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 100%;
      }
      .th-inner--right {
        justify-content: flex-end;
        width: 100%;
      }
      .th-inner--center {
        justify-content: center;
        width: 100%;
      }
      .th-icon {
        color: var(--erp-soft);
        flex-shrink: 0;
      }
      td {
        background: var(--erp-surface);
        color: var(--erp-text);
        font-size: 13.5px;
        font-family: inherit;
        font-variant-numeric: tabular-nums;
        transition: background 100ms ease;
      }
      td.is-mono .cell-primary {
        font-family: var(--erp-font-mono);
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      tbody tr:hover td {
        background: #F8FAFC;
      }
      tr.is-clickable {
        cursor: pointer;
      }
      tr.is-clickable:focus-visible td {
        background: var(--erp-accent-soft);
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
      .cell-box {
        display: flex;
        align-items: center;
        max-width: 100%;
        min-width: 0;
      }
      .cell-box--right {
        justify-content: flex-end;
      }
      .cell-box--center {
        justify-content: center;
      }
      .cell-box--clamped {
        white-space: normal;
      }
      .cell-stack {
        display: grid;
        gap: 2px;
        min-width: 0;
        max-width: 100%;
      }
      .cell-stack--right {
        justify-items: end;
      }
      .cell-inline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
      }
      .cell-inline--right {
        justify-content: flex-end;
      }
      .cell-primary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cell-subtext {
        display: block;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--erp-muted);
        font-size: 11.5px;
        font-weight: 400;
        line-height: 1.3;
      }
      .cell-topic-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex: 0 0 22px;
        border-radius: 6px;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      .cell-topic-icon--accent {
        background: var(--erp-accent-soft);
        color: var(--erp-accent);
      }
      .cell-topic-icon--success {
        background: var(--erp-success-soft);
        color: var(--erp-success);
      }
      .cell-topic-icon--warning {
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
      }
      .cell-topic-icon--danger {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      .cell-topic-icon--info {
        background: var(--erp-info-soft);
        color: var(--erp-info);
      }
      .cell-copy {
        opacity: 0;
      }
      tbody tr:hover .cell-copy,
      tbody tr:focus-within .cell-copy,
      .cell-copy:focus-visible {
        opacity: 1;
      }
      @media (hover: none) {
        .cell-copy {
          opacity: 0.85;
        }
      }
      .col-actions {
        position: sticky;
        right: 0;
        z-index: 1;
        width: 1%;
        padding-block: 6px;
        box-shadow: -8px 0 12px -10px rgba(15, 23, 42, 0.12);
      }
      th.col-actions {
        z-index: 3;
      }
      .row-actions {
        display: inline-flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .cell-media {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        max-width: 100%;
      }
      .cell-media__frame {
        display: inline-flex;
        width: 36px;
        height: 36px;
        flex: 0 0 36px;
        overflow: hidden;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .cell-media img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .cell-media--16-9 .cell-media__frame {
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
        font-weight: 600;
        color: var(--erp-ink);
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
        transform: scale(1.08);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
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
        font-family: var(--erp-font-mono);
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
  private readonly toast = inject(AdminErpToastService);

  readonly columns = input.required<readonly AdminTableColumn[]>();
  readonly rows = input.required<readonly unknown[]>();
  readonly loading = input(false);
  readonly error = input('');
  readonly errorTitle = input('Không tải được dữ liệu');
  readonly emptyTitle = input('Chưa có dữ liệu');
  readonly emptyMessage = input('');
  readonly emptyIcon = input('inbox');
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

  readonly copiedKey = signal('');
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  /** Resolves a primary badge for one cell, or null when the cell renders text/media. */
  badgeFor(column: AdminTableColumn, row: unknown): AdminTableCellBadge | null {
    return column.badge ? column.badge(row) : null;
  }

  /** Resolves a secondary badge displayed alongside the primary text value. */
  secondaryBadgeFor(column: AdminTableColumn, row: unknown): AdminTableCellBadge | null {
    return column.secondaryBadge ? column.secondaryBadge(row) : null;
  }

  /** Resolves a semantic topic icon for one cell. */
  cellIconFor(column: AdminTableColumn, row: unknown): AdminTableCellIcon | null {
    return column.cellIcon ? column.cellIcon(row) : null;
  }

  /** Resolves muted subtext beneath a primary cell value. */
  subtextFor(column: AdminTableColumn, row: unknown): string {
    return column.subtext ? column.subtext(row).trim() : '';
  }

  /** Resolves a 1-click copyable identifier for a cell, ignoring placeholders. */
  copyValueFor(column: AdminTableColumn, row: unknown): string {
    const raw = column.copyValue ? column.copyValue(row).trim() : '';
    return raw && raw !== '—' ? raw : '';
  }

  /** Builds an accessible hover title so truncated cells never hide data. */
  cellTitle(column: AdminTableColumn, row: unknown): string | null {
    if (column.badge || column.images || column.stars) return null;
    const primary = column.value(row)?.trim() || '';
    const sub = this.subtextFor(column, row);
    const combined = sub ? `${primary} · ${sub}` : primary;
    return combined && combined !== '—' ? combined : null;
  }

  /** Copies `value` to the clipboard without triggering row selection. */
  copyCell(event: Event, value: string, key: string): void {
    event.stopPropagation();
    void globalThis.navigator?.clipboard?.writeText?.(value);
    this.copiedKey.set(key);
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copiedKey.set(''), 1500);
    this.toast.info(`Đã sao chép: ${value}`);
  }

  /** Resolves a thumbnail for one cell, or null when the column carries no image. */
  imageFor(column: AdminTableColumn, row: unknown): string | null {
    const url = column.image ? column.image(row) : '';
    return url ? url : null;
  }

  /** Resolves multiple image thumbnails (e.g. customer attachments in reviews). */
  imagesFor(column: AdminTableColumn, row: unknown): readonly string[] | null {
    const list = column.images ? column.images(row) : null;
    return Array.isArray(list) && list.length ? list : null;
  }

  /** Resolves a numeric rating for visual star rendering. */
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

  /** Emits the selected row for a detail drawer/modal. */
  select(row: unknown): void {
    if (this.clickable()) {
      this.rowSelected.emit(row);
    }
  }

  /** Keyboard activation for a focused row. Space scrolls by default, so it is swallowed. */
  selectFromKeyboard(event: Event, row: unknown): void {
    event.preventDefault();
    this.select(row);
  }
}
