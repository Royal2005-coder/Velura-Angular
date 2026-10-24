import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Server-side filter shell. Controls are projected by the workspace.
 */
@Component({
  selector: 'app-erp-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="filter-bar" (ngSubmit)="apply.emit()" novalidate>
      <div class="filter-bar__fields"><ng-content /></div>
      <div class="filter-bar__actions">
        <button class="erp-btn erp-btn--primary erp-btn--sm" type="submit" [disabled]="busy()">Lọc</button>
        <button class="erp-btn erp-btn--sm" type="button" [disabled]="busy()" (click)="reset.emit()">Đặt lại</button>
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
        border-bottom: 1px solid var(--erp-line);
        background: var(--erp-surface);
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
  readonly apply = output<void>();
  readonly reset = output<void>();
}
