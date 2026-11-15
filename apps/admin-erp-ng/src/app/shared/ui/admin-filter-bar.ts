import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core';

/**
 * Server-side filter shell. Controls are projected by the workspace.
 * Selects, checkboxes and dates apply as soon as they change; text search applies after the operator
 * pauses typing (or on Enter). "Lọc" stays as an explicit submit, styled secondary so each screen keeps
 * one primary action.
 */
@Component({
  selector: 'app-erp-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="filter-bar" (submit)="submit($event)" (change)="onFieldChange($event)" (input)="onFieldInput($event)" novalidate>
      <div class="filter-bar__fields"><ng-content /></div>
      <div class="filter-bar__actions">
        <!-- Submit button: Enter in any filter field applies the filters (implicit form submission). -->
        <button class="erp-btn erp-btn--sm" type="submit" [disabled]="busy()">Lọc</button>
        <button class="erp-btn erp-btn--ghost erp-btn--sm" type="button" [disabled]="busy()" (click)="resetFilters()">Đặt lại</button>
        <ng-content select="[actions]" />
      </div>
    </form>
  `,
  styles: [
    `
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--erp-line-subtle);
        background: var(--erp-bg);
      }
      .filter-bar__fields {
        display: flex;
        flex: 1 1 520px;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 10px;
      }
      .filter-bar__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      @media (max-width: 720px) {
        .filter-bar__fields {
          flex-basis: 100%;
        }
        .filter-bar__actions {
          width: 100%;
          justify-content: flex-end;
        }
      }
    `,
  ],
})
export class AdminErpFilterBar {
  readonly busy = input(false);
  /** Apply on change/typing pause; set false for forms whose filters are expensive to run. */
  readonly autoApply = input(true);
  readonly apply = output<void>();
  readonly reset = output<void>();
  private searchTimer: number | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => window.clearTimeout(this.searchTimer));
  }

  /** Enter or "Lọc": apply now, cancelling a pending debounced search. */
  submit(event: Event): void {
    event.preventDefault();
    window.clearTimeout(this.searchTimer);
    this.apply.emit();
  }

  /** Clears filters through the owner and drops any pending search. */
  resetFilters(): void {
    window.clearTimeout(this.searchTimer);
    this.reset.emit();
  }

  /** Select/checkbox/radio/date: the choice is complete, apply immediately. */
  onFieldChange(event: Event): void {
    if (!this.autoApply() || this.busy() || isTextField(event.target)) return;
    this.apply.emit();
  }

  /** Text/search: wait for a typing pause so each keystroke doesn't hit the API. */
  onFieldInput(event: Event): void {
    if (!this.autoApply() || !isTextField(event.target)) return;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.apply.emit(), 450);
  }
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && ['text', 'search', 'email', 'tel', 'number', ''].includes(target.type);
}
