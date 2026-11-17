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
        gap: 6px;
        padding: 14px 16px;
        background: var(--erp-surface);
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-lg);
        box-shadow: var(--erp-shadow-sm);
        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
      }
      .kpi:hover {
        transform: translateY(-1px);
        box-shadow: var(--erp-shadow-md);
        border-color: var(--erp-line-strong);
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
        border-radius: 8px;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
        transition: transform 120ms ease;
      }
      .kpi:hover .kpi__icon {
        transform: scale(1.05);
      }
      .kpi--accent {
        border-top: 2px solid var(--erp-accent);
      }
      .kpi--accent .kpi__icon {
        background: var(--erp-accent-soft);
        color: var(--erp-accent);
      }
      .kpi--success {
        border-top: 2px solid var(--erp-success);
      }
      .kpi--success .kpi__icon {
        background: var(--erp-success-soft);
        color: var(--erp-success);
      }
      .kpi--warning {
        border-top: 2px solid var(--erp-warning);
      }
      .kpi--warning .kpi__icon {
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
      }
      .kpi--danger {
        border-top: 2px solid var(--erp-danger);
      }
      .kpi--danger .kpi__icon {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      .kpi--info {
        border-top: 2px solid var(--erp-info);
      }
      .kpi--info .kpi__icon {
        background: var(--erp-info-soft);
        color: var(--erp-info);
      }
      .kpi--neutral .kpi__icon {
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      strong {
        font-family: var(--erp-font-mono);
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.02em;
        line-height: 1.15;
        font-variant-numeric: tabular-nums;
        color: var(--erp-ink);
      }
      small {
        color: var(--erp-muted);
        font-size: 12px;
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
