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
      {{ label() }}
    </span>
  `,
  styles: [
    `
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }
      .badge i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .badge--neutral {
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      .badge--success {
        background: var(--erp-success-soft);
        color: var(--erp-success);
      }
      .badge--warning {
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
      }
      .badge--danger {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      .badge--info {
        background: var(--erp-info-soft);
        color: var(--erp-info);
      }
    `,
  ],
})
export class AdminErpStatusBadge {
  readonly label = input.required<string>();
  readonly tone = input<AdminBadgeTone>('neutral');
  readonly dot = input(false);
}
