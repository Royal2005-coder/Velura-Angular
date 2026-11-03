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
        padding: 18px 20px;
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
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
        transition: transform 120ms ease;
      }
      .kpi:hover .kpi__icon {
        transform: scale(1.05);
      }
      .kpi--accent .kpi__icon {
        background: #FFF1F3;
        color: #BE185D;
      }
      .kpi--success .kpi__icon {
        background: #ECFDF5;
        color: #059669;
      }
      .kpi--warning .kpi__icon {
        background: #FFFBEB;
        color: #D97706;
      }
      .kpi--danger .kpi__icon {
        background: #FFF1F2;
        color: #E11D48;
      }
      .kpi--info .kpi__icon {
        background: #EFF6FF;
        color: #2563EB;
      }
      .kpi--neutral .kpi__icon {
        background: #F8FAFC;
        color: #64748B;
      }
      strong {
        font-family: var(--erp-font);
        font-size: 26px;
        font-weight: 700;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
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
