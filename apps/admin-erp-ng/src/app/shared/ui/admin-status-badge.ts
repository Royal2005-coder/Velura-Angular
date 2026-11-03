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
        flex-shrink: 0;
        border-radius: 50%;
        background: currentColor;
      }
      .badge--neutral {
        background: #f1f5f9;
        color: #475569;
        border-color: #e2e8f0;
      }
      .badge--neutral i {
        background: #64748b;
      }
      .badge--success {
        background: #ecfdf5;
        color: #065f46;
        border-color: #a7f3d0;
      }
      .badge--success i {
        background: #10b981;
      }
      .badge--warning {
        background: #fffbeb;
        color: #92400e;
        border-color: #fde68a;
      }
      .badge--warning i {
        background: #f59e0b;
      }
      .badge--danger {
        background: #fff1f2;
        color: #9f1239;
        border-color: #fecdd3;
      }
      .badge--danger i {
        background: #f43f5e;
      }
      .badge--info {
        background: #eff6ff;
        color: #1e40af;
        border-color: #bfdbfe;
      }
      .badge--info i {
        background: #3b82f6;
      }
    `,
  ],
})
export class AdminErpStatusBadge {
  readonly label = input.required<string>();
  readonly tone = input<AdminBadgeTone>('neutral');
  readonly dot = input(false);
}
