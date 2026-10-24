import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Page-level heading with an optional workspace eyebrow and projected actions.
 */
@Component({
  selector: 'app-erp-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div class="page-head__copy">
        @if (eyebrow()) {
          <span class="page-head__eyebrow">{{ eyebrow() }}</span>
        }
        <h1>{{ title() }}</h1>
        @if (subtitle()) {
          <p>{{ subtitle() }}</p>
        }
      </div>
      <div class="page-head__actions">
        <ng-content select="[actions]" />
      </div>
    </header>
  `,
  styles: [
    `
      .page-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 20px;
      }
      .page-head__copy {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      .page-head__eyebrow {
        color: var(--erp-accent-strong);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1 {
        font-family: var(--erp-display);
        font-size: clamp(24px, 2.4vw, 32px);
        font-weight: 600;
        line-height: 1.15;
        color: var(--erp-ink);
      }
      p {
        max-width: 72ch;
        color: var(--erp-muted);
        font-size: 13px;
      }
      .page-head__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }
      @media (max-width: 760px) {
        .page-head {
          flex-direction: column;
          gap: 14px;
        }
        .page-head__actions {
          justify-content: flex-start;
        }
      }
    `,
  ],
})
export class AdminErpPageHeader {
  readonly eyebrow = input('');
  readonly title = input.required<string>();
  readonly subtitle = input('');
}
