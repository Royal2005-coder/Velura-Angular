import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Renders an icon from the shared admin sprite.
 */
@Component({
  selector: 'app-erp-icon',
  host: { style: 'display: inline-flex; flex: 0 0 auto;' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg [attr.width]="size()" [attr.height]="size()" aria-hidden="true"><use [attr.href]="href()"></use></svg>`,
  styles: [
    `
      svg {
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `,
  ],
})
export class AdminErpIcon {
  readonly name = input.required<string>();
  readonly size = input('18');
  readonly href = computed(() => `/admin-assets/icons/admin-icons.svg#${this.name()}`);
}
