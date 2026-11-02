import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-admin-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    style: 'display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; flex-shrink: 0;',
  },
  template: `<svg [class]="cssClass()" aria-hidden="true"><use [attr.href]="href()"></use></svg>`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
        flex-shrink: 0;
        width: 18px;
        height: 18px;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `,
  ],
})
export class AdminIcon {
  readonly name = input.required<string>();
  readonly cssClass = input('admin-line-icon');

  readonly href = computed(() => `/admin-assets/icons/admin-icons.svg#${this.name()}`);
}
