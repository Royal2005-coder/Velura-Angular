import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AdminErpIcon } from './admin-erp-icon';

/**
 * Empty/error state with semantic iconography (`inbox` for neutral empty queues, `alert` for errors) and projected action.
 */
@Component({
  selector: 'app-erp-empty-state',
  imports: [AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" [class.empty--error]="tone() === 'error'" [attr.role]="tone() === 'error' ? 'alert' : 'status'">
      <span class="empty__icon"><app-erp-icon [name]="resolvedIcon()" [size]="'22'" /></span>
      <strong>{{ title() }}</strong>
      @if (message()) {
        <p>{{ message() }}</p>
      }
      <div class="empty__actions"><ng-content /></div>
    </div>
  `,
  styles: [
    `
      .empty {
        display: grid;
        justify-items: center;
        gap: 8px;
        padding: 44px 20px;
        text-align: center;
        color: var(--erp-muted);
      }
      .empty__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        border-radius: 14px;
        border: 1px solid var(--erp-line);
        background: var(--erp-surface-muted);
        color: var(--erp-muted);
      }
      .empty--error .empty__icon {
        border-color: var(--erp-danger-line);
        background: var(--erp-danger-soft);
        color: var(--erp-danger);
      }
      strong {
        color: var(--erp-ink);
        font-size: 15px;
        font-weight: 600;
      }
      p {
        max-width: 48ch;
        font-size: 13px;
        line-height: 1.5;
      }
      .empty__actions:empty {
        display: none;
      }
      .empty__actions {
        margin-top: 4px;
      }
    `,
  ],
})
export class AdminErpEmptyState {
  readonly title = input.required<string>();
  readonly message = input('');
  readonly icon = input('inbox');
  readonly tone = input<'neutral' | 'error'>('neutral');
  readonly resolvedIcon = computed(() => (this.tone() === 'error' && this.icon() === 'inbox' ? 'alert' : this.icon()));
}
