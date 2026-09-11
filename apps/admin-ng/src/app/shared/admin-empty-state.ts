import { Component, input } from '@angular/core';
import { AdminIcon } from './admin-icon';

export type AdminEmptyKind = 'loading' | 'empty' | 'error';

/**
 * Shared loading / empty / error block for admin list modules.
 */
@Component({
  selector: 'app-admin-empty-state',
  imports: [AdminIcon],
  template: `
    <div class="admin-empty-state" [class.admin-order-empty]="true" [attr.data-kind]="kind()" role="status">
      <app-admin-icon [name]="icon()" />
      <strong>{{ title() }}</strong>
      @if (message()) {
        <p>{{ message() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class AdminEmptyState {
  readonly kind = input<AdminEmptyKind>('empty');
  readonly title = input.required<string>();
  readonly message = input('');
  readonly icon = input('search');
}
