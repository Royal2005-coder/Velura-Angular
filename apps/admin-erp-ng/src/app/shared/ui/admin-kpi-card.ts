import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AdminErpIcon } from './admin-erp-icon';

export type AdminKpiTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Compact KPI tile with a real loading state; never renders a fabricated zero while loading.
 */
@Component({
  selector: 'app-erp-kpi-card',
  imports: [AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="kpi" [class]="'kpi--' + tone()" [attr.aria-busy]="loading()">
      <div class="kpi__head">
        <span>{{ label() }}</span>
        @if (icon()) {
          <span class="kpi__icon"><app-erp-icon [name]="icon()" [size]="'16'" /></span>
        }
      </div>
      @if (loading()) {
        <span class="erp-skeleton kpi__skeleton"></span>
      } @else {
        <strong>{{ value() ?? '—' }}</strong>
      }
      @if (hint()) {
        <small>{{ hint() }}</small>
      }
    </article>
  `,
  styles: [
    `
      .kpi {
        position: relative;
        display: grid;
        gap: 8px;
        padding: 16px;
        overflow: hidden;
        background: var(--erp-surface);
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-md);
        box-shadow: var(--erp-shadow-sm);
      }
      .kpi::before {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        background: var(--erp-line-strong);
      }
      .kpi--accent::before {
        background: var(--erp-accent);
      }
      .kpi--success::before {
        background: var(--erp-success);
      }
      .kpi--warning::before {
        background: var(--erp-warning);
      }
      .kpi--danger::before {
        background: var(--erp-danger);
      }
      .kpi--info::before {
        background: var(--erp-info);
      }
      .kpi__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
      }
      .kpi__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      strong {
        font-family: var(--erp-display);
        font-size: 30px;
        font-weight: 600;
        line-height: 1;
        color: var(--erp-ink);
      }
      small {
        color: var(--erp-muted);
        font-size: 11px;
      }
      .kpi__skeleton {
        width: 70%;
        height: 30px;
      }
    `,
  ],
})
export class AdminErpKpiCard {
  readonly label = input.required<string>();
  readonly value = input<string | number | null>(null);
  readonly hint = input('');
  readonly tone = input<AdminKpiTone>('neutral');
  readonly icon = input('');
  readonly loading = input(false);
}
