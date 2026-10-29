import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface AdminErpTab {
  key: string;
  label: string;
  count?: number;
}

/**
 * Accessible tab strip with roving arrow-key navigation.
 */
@Component({
  selector: 'app-erp-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tabs" role="tablist" (keydown)="onKeydown($event)">
      @for (tab of tabs(); track tab.key) {
        <button
          type="button"
          role="tab"
          class="tabs__item"
          [class.is-active]="tab.key === active()"
          [attr.aria-selected]="tab.key === active()"
          [attr.tabindex]="tab.key === active() ? 0 : -1"
          [disabled]="busy()"
          (click)="select(tab.key)"
        >
          {{ tab.label }}
          @if (tab.count !== undefined) {
            <span class="tabs__count">{{ tab.count }}</span>
          }
        </button>
      }
      @if (busy()) {
        <span class="tabs__spinner" role="status" aria-label="Đang tải dữ liệu"></span>
      }
    </div>
  `,
  styles: [
    `
      .tabs {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .tabs__item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 0 12px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .tabs__item:hover {
        color: var(--erp-text);
      }
      .tabs__item:disabled {
        cursor: progress;
        opacity: 0.62;
      }
      .tabs__spinner {
        width: 13px;
        height: 13px;
        margin: 0 6px;
        border: 2px solid var(--erp-line);
        border-top-color: var(--erp-accent);
        border-radius: 50%;
        animation: tabs-spin 700ms linear infinite;
      }
      @keyframes tabs-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .tabs__item.is-active {
        background: var(--erp-surface);
        color: var(--erp-ink);
        box-shadow: var(--erp-shadow-sm);
      }
      .tabs__count {
        min-width: 18px;
        padding: 1px 5px;
        border-radius: 999px;
        background: var(--erp-accent-soft);
        color: var(--erp-accent-strong);
        font-size: 10px;
        text-align: center;
      }
    `,
  ],
})
export class AdminErpTabs {
  readonly tabs = input.required<readonly AdminErpTab[]>();
  readonly active = input.required<string>();
  /** Blocks tab changes and shows a spinner while the current one is loading. */
  readonly busy = input(false);
  readonly changed = output<string>();

  /**
   * Emits the selected tab key.
   */
  select(key: string): void {
    if (this.busy()) {
      return;
    }
    if (key !== this.active()) {
      this.changed.emit(key);
    }
  }

  /**
   * Moves focus and selection with Left/Right/Home/End.
   */
  onKeydown(event: KeyboardEvent): void {
    if (this.busy()) {
      return;
    }
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.key === this.active());
    if (index < 0) {
      return;
    }
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    this.changed.emit(tabs[next].key);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[next]?.focus();
  }
}
