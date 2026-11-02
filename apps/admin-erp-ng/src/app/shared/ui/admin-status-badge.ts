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
        gap: 5px;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 600;
        white-space: nowrap;
        border: 1px solid transparent;
      }
      .badge i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .badge--neutral {
        background: #f1f5f9;
        color: #475569;
        border-color: #e2e8f0;
      }
      .badge--success {
        background: #f0fdf4;
        color: #166534;
        border-color: #bbf7d0;
      }
      .badge--warning {
        background: #fffbeb;
        color: #b45309;
        border-color: #fde68a;
      }
      .badge--danger {
        background: #fef2f2;
        color: #991b1b;
        border-color: #fecaca;
      }
      .badge--info {
        background: #f0f9ff;
        color: #0369a1;
        border-color: #bae6fd;
      }
    `,
  ],
})
export class AdminErpStatusBadge {
  readonly label = input.required<string>();
  readonly tone = input<AdminBadgeTone>('neutral');
  readonly dot = input(false);
}
