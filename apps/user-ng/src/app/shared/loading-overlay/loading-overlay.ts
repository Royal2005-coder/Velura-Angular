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
      <div class="loading-overlay" role="status" aria-live="polite" aria-busy="true">
        <div class="loading-overlay__card">
          <span class="loading-overlay__spinner" aria-hidden="true"></span>
          <span class="loading-overlay__text">{{ label() }}</span>
        </div>
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
        background: rgba(252, 248, 249, 0.74);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        cursor: progress;
        pointer-events: all;
        animation: loading-overlay-fade 160ms ease-out;
      }
      .loading-overlay__card {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        padding: 14px 24px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(122, 31, 61, 0.14);
        box-shadow: 0 12px 32px rgba(43, 27, 34, 0.1);
        color: #2b1b22;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .loading-overlay__spinner {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        border: 2.2px solid rgba(122, 31, 61, 0.18);
        border-top-color: #7a1f3d;
        border-radius: 50%;
        animation: loading-overlay-spin 680ms linear infinite;
      }
      @keyframes loading-overlay-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes loading-overlay-fade {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
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
