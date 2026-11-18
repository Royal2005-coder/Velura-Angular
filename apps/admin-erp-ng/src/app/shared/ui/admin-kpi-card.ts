import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { AdminErpIcon } from './admin-erp-icon';

export type AdminKpiTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Compact SaaS KPI tile with zero-overflow clamping, real skeleton state, and optional interactive filter mode.
 */
@Component({
  selector: 'app-erp-kpi-card',
  imports: [AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article
      class="kpi"
      [class]="'kpi kpi--' + tone()"
      [class.kpi--interactive]="interactive()"
      [class.is-active]="active()"
      [attr.role]="interactive() ? 'button' : null"
      [attr.tabindex]="interactive() ? 0 : null"
      [attr.aria-pressed]="interactive() ? active() : null"
      [attr.aria-busy]="loading()"
      (click)="activate()"
      (keydown.enter)="activate()"
      (keydown.space)="activateKey($event)"
    >
      <div class="kpi__head">
        <span class="kpi__label" [attr.title]="label()">{{ label() }}</span>
        @if (icon()) {
          <span class="kpi__icon"><app-erp-icon [name]="icon()" [size]="'16'" /></span>
        }
      </div>
      @if (loading()) {
        <span class="erp-skeleton kpi__skeleton"></span>
      } @else {
        <strong [attr.title]="valueTitle()">{{ value() ?? '—' }}</strong>
      }
      @if (hint()) {
        <small [attr.title]="hint()">{{ hint() }}</small>
      }
    </article>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .kpi {
        position: relative;
        display: grid;
        gap: 6px;
        min-width: 0;
        height: 100%;
        padding: 14px 16px;
        background: var(--erp-surface);
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-lg);
        box-shadow: var(--erp-shadow-sm);
        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;
      }
      .kpi:hover {
        border-color: var(--erp-line-strong);
        box-shadow: var(--erp-shadow-md);
      }
      .kpi--interactive {
        cursor: pointer;
        user-select: none;
      }
      .kpi--interactive:hover {
        transform: translateY(-1px);
        border-color: var(--erp-accent-border);
      }
      .kpi--interactive.is-active {
        border-color: var(--erp-accent);
        background: linear-gradient(180deg, #FFF8FA 0%, #FFFFFF 100%);
        box-shadow: 0 0 0 2px rgba(190, 24, 93, 0.14);
      }
      .kpi__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
      }
      .kpi__label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kpi__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex: 0 0 30px;
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
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--erp-font-mono);
        font-size: clamp(18px, 1.55vw, 22px);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.2;
        font-variant-numeric: tabular-nums;
        color: var(--erp-ink);
      }
      small {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--erp-muted);
        font-size: 11.5px;
      }
      .kpi__skeleton {
        width: 70%;
        height: 28px;
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
  /** Enables 1-click filter/queue switching directly from the KPI tile. */
  readonly interactive = input(false);
  readonly active = input(false);
  readonly selected = output<void>();

  readonly valueTitle = computed(() => {
    const val = this.value();
    return val !== null && val !== undefined ? String(val) : null;
  });

  /** Emits `selected` when interactive mode is enabled. */
  activate(): void {
    if (this.interactive()) {
      this.selected.emit();
    }
  }

  /** Keyboard Space handler for interactive KPI cards. */
  activateKey(event: Event): void {
    if (this.interactive()) {
      event.preventDefault();
      this.selected.emit();
    }
  }
}
