import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-admin-icon',
  host: { style: 'display: contents' },
  template: `<svg [class]="cssClass()"><use [attr.href]="href()"></use></svg>`,
})
export class AdminIcon {
  readonly name = input.required<string>();
  readonly cssClass = input('admin-line-icon');

  readonly href = computed(() => `/admin-assets/icons/admin-icons.svg#${this.name()}`);
}
