import { ChangeDetectionStrategy, Component, ElementRef, effect, input, signal, viewChild } from '@angular/core';
import { toCanvas, toDataURL } from 'qrcode';

/**
 * Renders one QR payload and offers a PNG download.
 *
 * Dùng cho mã đơn/phiếu trả (in kèm label) và cho mã vận đơn mẫu trong hộp quét,
 * nên payload do caller quyết định — component này không tự ghép nội dung.
 */
@Component({
  selector: 'app-erp-qr-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="qr">
      <canvas #canvas [attr.aria-label]="caption() || 'Mã QR'"></canvas>
      @if (caption()) {
        <figcaption>{{ caption() }}</figcaption>
      }
      <button class="erp-btn erp-btn--sm" type="button" (click)="download()" [disabled]="failed()">Tải PNG</button>
    </figure>
  `,
  styles: [
    `
      .qr {
        display: grid;
        justify-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: #fff;
      }
      canvas {
        width: 100%;
        max-width: 180px;
        height: auto;
        image-rendering: pixelated;
      }
      figcaption {
        font-size: 0.76rem;
        color: var(--erp-text-muted);
        text-align: center;
      }
    `,
  ],
})
export class AdminErpQrCode {
  readonly value = input.required<string>();
  readonly size = input(180);
  readonly caption = input('');
  readonly failed = signal(false);

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      const element = this.canvas()?.nativeElement;
      const value = this.value();
      if (!element || !value) return;
      toCanvas(element, value, { width: this.size(), margin: 1, errorCorrectionLevel: 'M' })
        .then(() => this.failed.set(false))
        .catch(() => this.failed.set(true));
    });
  }

  /**
   * Downloads a larger PNG so the label stays scannable after printing.
   */
  download(): void {
    toDataURL(this.value(), { width: 720, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'velura-qr.png';
        anchor.click();
      })
      .catch(() => this.failed.set(true));
  }
}
