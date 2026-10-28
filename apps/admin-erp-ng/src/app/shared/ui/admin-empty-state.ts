import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AdminErpIcon } from './admin-erp-icon';

/**
 * Empty/error state with an optional projected action.
 */
@Component({
  selector: 'app-erp-empty-state',
  imports: [AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" [class.empty--error]="tone() === 'error'" [attr.role]="tone() === 'error' ? 'alert' : 'status'">
      <span class="empty__icon"><app-erp-icon [name]="icon()" [size]="'22'" /></span>
      <strong>{{ title() }}</strong>
      @if (message()) {
        <p>{{ message() }}</p>
      }
      <ng-content />
    </div>
  `,
  styles: [
    `
      .empty {
        display: grid;
        justify-items: center;
        gap: 8px;
        padding: 40px 20px;
        text-align: center;
        color: var(--erp-muted);
      }
      .empty__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 46px;
        height: 46px;
        border-radius: 50%;
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      .empty--error .empty__icon {
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      strong {
        color: var(--erp-text);
        font-size: 14px;
      }
      p {
        max-width: 48ch;
        font-size: 12px;
      }
    `,
  ],
})
export class AdminErpEmptyState {
  readonly title = input.required<string>();
  readonly message = input('');
  readonly icon = input('alert');
  readonly tone = input<'neutral' | 'error'>('neutral');
}
