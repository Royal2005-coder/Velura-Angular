import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Dense table skeleton that matches the ERP list layout.
 */
@Component({
  selector: 'app-erp-table-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="skeleton-table" aria-hidden="true">
      @for (row of rowItems(); track $index) {
        <div class="skeleton-row">
          @for (column of columnItems(); track $index) {
            <span class="erp-skeleton" [style.width]="column"></span>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .skeleton-table {
        display: grid;
      }
      .skeleton-row {
        display: grid;
        grid-template-columns: repeat(var(--columns, 4), minmax(0, 1fr));
        gap: 20px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--erp-line);
      }
      .skeleton-row:last-child {
        border-bottom: 0;
      }
      span {
        height: 12px;
        justify-self: start;
      }
    `,
  ],
  host: { '[style.--columns]': 'columns()' },
})
export class AdminErpTableSkeleton {
  readonly rows = input(5);
  readonly columns = input(4);
  readonly rowItems = computed(() => Array.from({ length: Math.max(1, this.rows()) }));
  readonly columnItems = computed(() =>
    Array.from({ length: Math.max(1, this.columns()) }, (_, index) => (index === 0 ? '64%' : '42%')),
  );
}
