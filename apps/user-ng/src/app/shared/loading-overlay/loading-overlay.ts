import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Blocking busy layer for long customer actions (placing an order, submitting a return).
 * It tells the customer the request is in flight so they neither retap nor leave the page.
 */
@Component({
  selector: 'app-loading-overlay',
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
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(255, 255, 255, 0.72);
        color: #2b1b22;
        font-weight: 600;
        cursor: progress;
        backdrop-filter: blur(2px);
      }
      .loading-overlay__spinner {
        width: 22px;
        height: 22px;
        border: 2px solid rgba(43, 27, 34, 0.18);
        border-top-color: #7a1f3d;
        border-radius: 50%;
        animation: loading-overlay-spin 700ms linear infinite;
      }
      @keyframes loading-overlay-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class LoadingOverlay {
  /** Whether the layer is shown. */
  readonly active = input(false);
  /** Message announced to the customer. */
  readonly label = input('Đang xử lý…');
}
