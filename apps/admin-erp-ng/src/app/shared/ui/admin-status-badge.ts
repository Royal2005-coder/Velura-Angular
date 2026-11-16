import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type AdminBadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * Status pill used by every workspace so one business state has one visual tone.
 */
@Component({
  selector: 'app-erp-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="badge" [class]="'badge--' + tone()">
      @if (dot()) {
        <i aria-hidden="true"></i>
      }
      <span class="badge__text">{{ label() }}</span>
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-block;
        max-width: 100%;
        vertical-align: middle;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.5;
        white-space: nowrap;
        border: 1px solid transparent;
      }
      .badge__text {
        display: block;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge i {
        width: 6px;
        height: 6px;
        flex-shrink: 0;
        border-radius: 50%;
        background: currentColor;
      }
      .badge--neutral {
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
        border-color: var(--erp-line);
      }
      .badge--success {
        background: var(--erp-success-soft);
        color: var(--erp-success);
        border-color: color-mix(in srgb, var(--erp-success) 22%, transparent);
      }
      .badge--warning {
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
        border-color: var(--erp-warning-line);
      }
      .badge--danger {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
        border-color: var(--erp-danger-line);
      }
      .badge--info {
        background: var(--erp-info-soft);
        color: var(--erp-info);
        border-color: color-mix(in srgb, var(--erp-info) 22%, transparent);
      }
    `,
  ],
})
export class AdminErpStatusBadge {
  readonly label = input.required<string>();
  readonly tone = input<AdminBadgeTone>('neutral');
  readonly dot = input(false);
}
