import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Blocking busy layer for a detail request started from a list row. It paints immediately on
 * click so the row does not look frozen while the drawer payload is on the wire.
 */
@Component({
  selector: 'app-erp-loading-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <div class="loading-overlay" role="status" aria-live="polite">
        <span class="loading-overlay__spinner" aria-hidden="true"></span>
        <span>{{ label() }}</span>
      </div>
    }
  `,
  styles: [
    `
      .loading-overlay {
        position: fixed;
        inset: 0;
        z-index: 96;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: color-mix(in srgb, var(--erp-ink) 16%, transparent);
        color: var(--erp-ink);
        font-size: 13px;
        font-weight: 600;
        cursor: progress;
        backdrop-filter: blur(1px);
        animation: loading-overlay-in 120ms ease-out both;
      }
      .loading-overlay__spinner {
        width: 20px;
        height: 20px;
        border: 2px solid color-mix(in srgb, var(--erp-ink) 18%, transparent);
        border-top-color: var(--erp-accent);
        border-radius: 50%;
        animation: loading-overlay-spin 650ms linear infinite;
      }
      @keyframes loading-overlay-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes loading-overlay-in {
        from {
          opacity: 0;
        }
      }
    `,
  ],
})
export class AdminErpLoadingOverlay {
  readonly active = input(false);
  readonly label = input('Đang tải dữ liệu…');
}
